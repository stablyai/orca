import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import type { SshTarget } from '../../../shared/ssh-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../loading-store/store'
import { createOrcadMigrationManifest } from '../../ssh/orcad-migration-manifest-export'
import {
  getProfileTerminalScrollbackSnapshotRoot,
  readTerminalScrollbackStoredBytesSync,
  writeTerminalScrollbackSnapshotSync
} from '../../pty/scrollback/terminal-scrollback-snapshots'

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

describe('exporting a relay-hosted SSH target from the profile store', () => {
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

  // #29083: an enabled automation refused every Connect and left the host unconnectable.

  // #30126: three parked shells' local-only scrollback, inlined, overflowed the 768 KB manifest.

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
