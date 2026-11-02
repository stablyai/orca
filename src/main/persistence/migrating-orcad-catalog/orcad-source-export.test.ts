import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import type { SshTarget } from '../../../shared/ssh-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../loading-store/store'
import { createOrcadMigrationManifest } from '../../ssh/orcad-migration-manifest-export'
import { parseOrcadMigrationManifest } from '../../../shared/orcad-migration/orcad-migration-manifest-validation'
import { orcadMigrationRefusalReason } from '../../ssh/orcad-migration-refusal-reason'
import { collectUntransferredDependentBlockers } from '../../ssh/targets/ssh-target-orcad-dependents'
import {
  getProfileTerminalScrollbackSnapshotRoot,
  readTerminalScrollbackStoredBytesSync,
  writeTerminalScrollbackSnapshotSync
} from '../../terminal-scrollback-snapshots'

const TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 3
}
const REPO_ID = 'repo-1'
const WORKTREE_ID = `${REPO_ID}::/srv/app`

const directories: string[] = []
const dataFiles: string[] = []
afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function dormantSession(buffer: string): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: 'tab-1',
          ptyId: null,
          worktreeId: WORKTREE_ID,
          title: 'Shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null,
        buffersByLeafId: { 'leaf-1': buffer }
      }
    }
  }
}

function sourceStore(): Store {
  const directory = mkdtempSync(join(tmpdir(), 'orcad-source-export-'))
  directories.push(directory)
  dataFiles.push(join(directory, 'orca-data.json'))
  const store = createSqliteTestStore(Store, { dataFile: dataFiles.at(-1)! })
  store.addSshTarget(TARGET)
  store.addRepo({
    id: REPO_ID,
    path: '/srv/app',
    displayName: 'App',
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    connectionId: TARGET.id
  })
  store.setWorkspaceSession(dormantSession('dormant output\r\n'), toSshExecutionHostId(TARGET.id))
  return store
}

function sshAutomation(store: Store) {
  return store.createAutomation({
    name: 'Nightly check',
    prompt: 'Check the repo',
    agentId: 'claude',
    projectId: REPO_ID,
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: 1
  })
}

describe('exporting a relay-hosted SSH target from the profile store', () => {
  it('reads the target catalog and dormant scrollback without changing the source', () => {
    const store = sourceStore()
    const before = JSON.stringify({
      repos: store.getRepos(),
      session: store.getWorkspaceSession(toSshExecutionHostId(TARGET.id))
    })

    const manifest = createOrcadMigrationManifest(store, TARGET)

    expect(manifest.payload.repositories.map((repo) => repo.id)).toEqual([REPO_ID])
    const snapshots = manifest.payload.dormantState?.terminalScrollbackSnapshots ?? []
    expect(snapshots).toHaveLength(1)
    const chunk = store.readOrcadMigrationSourceSnapshotChunk(manifest, snapshots[0]!.ref, 0)
    expect(Buffer.from(chunk.bytesBase64, 'base64').toString('utf8')).toBe('dormant output\r\n')
    expect(chunk.eof).toBe(true)
    expect(
      JSON.stringify({
        repos: store.getRepos(),
        session: store.getWorkspaceSession(toSshExecutionHostId(TARGET.id))
      })
    ).toBe(before)
  })

  it('refuses a chunk once the dormant buffer changed after export', () => {
    const store = sourceStore()
    const manifest = createOrcadMigrationManifest(store, TARGET)
    const ref = manifest.payload.dormantState?.terminalScrollbackSnapshots?.[0]?.ref ?? ''
    store.setWorkspaceSession(dormantSession('rewritten output'), toSshExecutionHostId(TARGET.id))
    expect(() => store.readOrcadMigrationSourceSnapshotChunk(manifest, ref, 0)).toThrow(
      'orcad_migration_source_snapshot_changed'
    )
  })

  it('finishes a retained transfer after the tab closes, then deletes the orphaned file', () => {
    const store = sourceStore()
    const hostId = toSshExecutionHostId(TARGET.id)
    const storage = { snapshotRoot: getProfileTerminalScrollbackSnapshotRoot(dataFiles.at(-1)!) }
    const stored = writeTerminalScrollbackSnapshotSync({
      tabId: 'tab-1',
      leafId: 'leaf-1',
      buffer: 'dormant output\r\n',
      storage
    })!
    const session = dormantSession('')
    session.terminalLayoutsByTabId['tab-1'] = {
      ...session.terminalLayoutsByTabId['tab-1']!,
      buffersByLeafId: {},
      scrollbackRefsByLeafId: { 'leaf-1': stored }
    }
    store.setWorkspaceSession(session, hostId)
    const manifest = createOrcadMigrationManifest(store, TARGET)
    const ref = manifest.payload.dormantState?.terminalScrollbackSnapshots?.[0]?.ref ?? ''
    expect(ref).toBe(stored)
    store.syncOrcadMigrationScrollbackRetention([manifest])
    store.setWorkspaceSession(getDefaultWorkspaceSession(), hostId)

    const chunk = store.readOrcadMigrationSourceSnapshotChunk(manifest, ref, 0)
    expect(Buffer.from(chunk.bytesBase64, 'base64').toString('utf8')).toBe('dormant output\r\n')
    store.syncOrcadMigrationScrollbackRetention([])
    expect(readTerminalScrollbackStoredBytesSync(ref, storage)).toBeNull()
  })

  it('serves an inline dormant buffer after its tab closes, across retries, until released', () => {
    const store = sourceStore()
    const hostId = toSshExecutionHostId(TARGET.id)
    const storage = { snapshotRoot: getProfileTerminalScrollbackSnapshotRoot(dataFiles.at(-1)!) }
    const manifest = createOrcadMigrationManifest(store, TARGET)
    const ref = manifest.payload.dormantState?.terminalScrollbackSnapshots?.[0]?.ref ?? ''
    store.syncOrcadMigrationScrollbackRetention([manifest])
    store.setWorkspaceSession(getDefaultWorkspaceSession(), hostId)

    for (let attempt = 0; attempt < 2; attempt += 1) {
      store.syncOrcadMigrationScrollbackRetention([manifest])
      const chunk = store.readOrcadMigrationSourceSnapshotChunk(manifest, ref, 0)
      expect(Buffer.from(chunk.bytesBase64, 'base64').toString('utf8')).toBe('dormant output\r\n')
    }
    store.syncOrcadMigrationScrollbackRetention([])
    expect(readTerminalScrollbackStoredBytesSync(ref, storage)).toBeNull()
  })

  it('refuses a chunk for a manifest whose digest does not match its contents', () => {
    const store = sourceStore()
    const manifest = createOrcadMigrationManifest(store, TARGET)
    const ref = manifest.payload.dormantState?.terminalScrollbackSnapshots?.[0]?.ref ?? ''
    expect(() =>
      store.readOrcadMigrationSourceSnapshotChunk({ ...manifest, migrationId: 'forged' }, ref, 0)
    ).toThrow('orcad_migration_manifest_digest_mismatch')
  })

  it('names what still blocks: nothing, once the dormant state is exportable', () => {
    const store = sourceStore()
    const manifest = createOrcadMigrationManifest(store, TARGET)
    const census = store.inspectOrcadMigrationUntransferredDependencies(manifest)
    expect(census.counts['workspace-session']).toBe(0)
  })

  // #29083: an enabled automation refused every Connect and left the host unconnectable.
  it('moves an enabled SSH automation with its finished runs, sent disabled as older servers expect', () => {
    const store = sourceStore()
    const automation = sshAutomation(store)
    const run = store.createAutomationRun(automation, 1)
    store.updateAutomationRun({ runId: run.id, status: 'completed', workspaceId: null })

    const manifest = createOrcadMigrationManifest(store, TARGET)

    expect(manifest.payload.dormantState?.automations).toEqual([
      expect.objectContaining({ id: automation.id, enabled: false })
    ])
    expect(manifest.payload.dormantState?.automationRuns).toEqual([
      expect.objectContaining({ id: run.id, status: 'completed' })
    ])
    expect(() => parseOrcadMigrationManifest(manifest)).not.toThrow()
    expect(collectUntransferredDependentBlockers(store, manifest)).toEqual([])
    expect(store.listAutomations()[0]?.enabled).toBe(true)
  })

  it('waits for an automation run still in flight, and says so', () => {
    const store = sourceStore()
    const automation = sshAutomation(store)
    store.createAutomationRun(automation, 1)

    const manifest = createOrcadMigrationManifest(store, TARGET)

    expect(manifest.payload.dormantState?.automations).toBeUndefined()
    expect(
      orcadMigrationRefusalReason(collectUntransferredDependentBlockers(store, manifest))
    ).toBe(
      'This SSH host cannot move yet: automations (1), automation runs (Nightly check is running; wait for it to finish, then connect again).'
    )
  })

  // #30126: three parked shells' local-only scrollback, inlined, overflowed the 768 KB manifest.
  it('moves local-only scrollback through the snapshot channel, not the manifest', () => {
    const store = sourceStore()
    const hostId = toSshExecutionHostId(TARGET.id)
    const output = (tabId: string): string =>
      Array.from({ length: 30_000 }, (_, line) => `${tabId} line ${line}\r\n`).join('')
    const session = dormantSession('shared output\r\n')
    const shell = session.tabsByWorktree[WORKTREE_ID]![0]!
    const tabIds = ['tab-1', 'tab-2', 'tab-3']
    const leafOf = (tabId: string): string => (tabId === 'tab-1' ? 'leaf-1' : `leaf-${tabId}`)
    session.tabsByWorktree[WORKTREE_ID] = tabIds.map((id, sortOrder) => ({
      ...shell,
      id,
      sortOrder
    }))
    for (const tabId of tabIds.slice(1)) {
      session.terminalLayoutsByTabId[tabId] = {
        root: { type: 'leaf', leafId: leafOf(tabId) },
        activeLeafId: leafOf(tabId),
        expandedLeafId: null
      }
    }
    session.localOnlyScrollbackByTabId = Object.fromEntries(
      tabIds.map((tabId) => [tabId, { [leafOf(tabId)]: output(tabId) }])
    )
    store.setWorkspaceSession(session, hostId)
    const saved = store.getWorkspaceSession(hostId).localOnlyScrollbackByTabId
    expect(JSON.stringify(saved).length).toBeGreaterThan(768 * 1024)

    const manifest = createOrcadMigrationManifest(store, TARGET)

    const dormant = manifest.payload.dormantState
    expect(dormant?.workspaceSession?.localOnlyScrollbackByTabId).toBeUndefined()
    const snapshots = dormant?.terminalScrollbackSnapshots ?? []
    expect(snapshots.map((snapshot) => snapshot.tabId)).toEqual(tabIds)
    for (const snapshot of snapshots) {
      expect(
        dormant?.workspaceSession?.terminalLayoutsByTabId[snapshot.tabId]?.scrollbackRefsByLeafId
      ).toEqual({ [leafOf(snapshot.tabId)]: snapshot.ref })
      let bytes = ''
      for (let offset = 0, eof = false; !eof;) {
        const chunk = store.readOrcadMigrationSourceSnapshotChunk(manifest, snapshot.ref, offset)
        const piece = Buffer.from(chunk.bytesBase64, 'base64')
        bytes += piece.toString('utf8')
        offset += piece.length
        eof = chunk.eof
      }
      // Match renderer precedence: local-only scrollback wins.
      expect(bytes).toBe(saved?.[snapshot.tabId]?.[leafOf(snapshot.tabId)])
    }
  })

  it('retains the newer local-only bytes over an older file saved under the same ref', () => {
    const store = sourceStore()
    const hostId = toSshExecutionHostId(TARGET.id)
    const storage = { snapshotRoot: getProfileTerminalScrollbackSnapshotRoot(dataFiles.at(-1)!) }
    const stored = writeTerminalScrollbackSnapshotSync({
      tabId: 'tab-1',
      leafId: 'leaf-1',
      buffer: 'older shared output\r\n',
      storage
    })!
    const session = dormantSession('')
    session.terminalLayoutsByTabId['tab-1'] = {
      ...session.terminalLayoutsByTabId['tab-1']!,
      buffersByLeafId: {},
      scrollbackRefsByLeafId: { 'leaf-1': stored }
    }
    session.localOnlyScrollbackByTabId = { 'tab-1': { 'leaf-1': 'newer parked output\r\n' } }
    store.setWorkspaceSession(session, hostId)
    const manifest = createOrcadMigrationManifest(store, TARGET)
    const ref = manifest.payload.dormantState?.terminalScrollbackSnapshots?.[0]?.ref ?? ''
    expect(ref).toBe(stored)
    store.syncOrcadMigrationScrollbackRetention([manifest])
    store.setWorkspaceSession(getDefaultWorkspaceSession(), hostId)

    const chunk = store.readOrcadMigrationSourceSnapshotChunk(manifest, ref, 0)
    expect(Buffer.from(chunk.bytesBase64, 'base64').toString('utf8')).toBe(
      'newer parked output\r\n'
    )
  })
})
