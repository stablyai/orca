import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StoreRuntimeState } from './store-runtime-state'
import { createStoreDomains } from './store-domain-composition'
import { liveSourceRetirementFixture } from '../migrating-orcad-catalog/orcad-live-source-retirement-test-fixture'
import { OrcadSourceRetirementPersistence } from '../migrating-orcad-catalog/orcad-source-retirement-persistence'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  writeTerminalScrollbackSnapshotSync,
  readTerminalScrollbackSnapshotSync
} from '../../terminal-scrollback-snapshots'
import { deleteRemovedTerminalScrollbackSnapshots } from './terminal-session-cleanup'
import { deleteRemovedTerminalScrollbackSnapshotsAsync } from '../../terminal-scrollback-snapshot-async-migration'
import { OrcadRetirementSessionPublication } from './orcad-retirement-session-publication'
import { collectOrcadRetirementSnapshotRefs } from './orcad-retirement-session-write'
import { requireOrcadRetirementRendererEvidence } from './orcad-retirement-renderer-evidence'
import { OrcadLiveCompletionDurability } from './orcad-live-completion-durability'
import { createOrcadLiveCompletedCutover } from '../../ssh/orcad-live-completed-cutover'

const directories: string[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function fixture(kind: 'folder' | 'worktree' = 'folder', snapshotRef?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-retirement-write-'))
  directories.push(directory)
  const f = liveSourceRetirementFixture(kind, 'ssh-1', true)
  if (snapshotRef) {
    f.state.workspaceSession.terminalLayoutsByTabId['unrelated-tab'] = {
      root: { type: 'leaf', leafId: 'leaf' },
      activeLeafId: 'leaf',
      expandedLeafId: null,
      scrollbackRefsByLeafId: { leaf: snapshotRef }
    }
  }
  const runtime = new StoreRuntimeState({ dataFile: join(directory, 'orca-data.json') })
  await Promise.all([runtime.staleTempCleanup, runtime.staleGithubCacheTempCleanup])
  runtime.state = f.state
  const domains = createStoreDomains(runtime)
  domains.orcadSourceRetirement = new OrcadSourceRetirementPersistence(runtime, domains.scheduling)
  const release = {
    version: 1,
    cutover: f.cutover,
    activations: f.cutover.terminalPublications!.map((publication) => ({
      version: 1,
      identity: publication.identity,
      publicationReceipt: publication.publicationReceipt,
      destinationClaim: { generation: 1, claimId: 'claim' },
      catalog: publication.catalog
    }))
  }
  const before = structuredClone(f.state.workspaceSession)
  const record = domains.orcadSourceRetirement.createOrcadLiveSourceRetirementRecord(
    release,
    f.sourceAdmission
  )
  const install = () =>
    domains.orcadSourceRetirement.installOrcadLiveRetirementProfile(
      record,
      f.sourceAdmission,
      f.cutover.updatedAt
    )
  return { ...f, runtime, domains, before, record, install, directory }
}

it.each(['folder', 'worktree'] as const)(
  'reconciles exact stale local %s layouts while retaining unrelated edits',
  async (kind) => {
    const f = await fixture(kind)
    f.install()
    const browserUrlHistory = [
      {
        url: 'https://example.test/',
        normalizedUrl: 'https://example.test',
        title: 'New',
        visitCount: 1,
        lastVisitedAt: 2
      }
    ]
    f.domains.sessionSnapshots.patchWorkspaceSession({
      terminalLayoutsByTabId: f.before.terminalLayoutsByTabId,
      activeConnectionIdsAtShutdown: f.before.activeConnectionIdsAtShutdown,
      browserUrlHistory
    })
    expect(f.state.workspaceSession.terminalLayoutsByTabId).toEqual({})
    expect(f.state.workspaceSession.activeConnectionIdsAtShutdown ?? []).not.toContain('ssh-1')
    expect(f.state.workspaceSession.browserUrlHistory).toEqual(browserUrlHistory)
    expect(
      f.domains.orcadSourceRetirement.inspectOrcadLiveRetirementProfileState(f.record).state
    ).toBe('profile-installed')
  }
)

it('reconciles scalar-only reconnect replay through the patch fast path', async () => {
  const f = await fixture()
  f.install()
  f.domains.sessionSnapshots.patchWorkspaceSession({
    activeConnectionIdsAtShutdown: ['ssh-1', 'other-host']
  })
  expect(f.state.workspaceSession.activeConnectionIdsAtShutdown).toEqual(['other-host'])
})

it('persists destination-owned selection of the migrated workspace through ordinary patching', async () => {
  const f = await fixture('worktree')
  f.install()
  const selection = {
    activeWorkspaceExecutionHostId: `runtime:${f.cutover.destinationEnvironmentId}` as const,
    activeRepoId: f.cutover.manifest.payload.repositories[0].id,
    activeWorktreeId: 'repo-1::/srv/worktree',
    activeWorkspaceKey: 'worktree:repo-1::/srv/worktree' as const
  }
  f.domains.sessionSnapshots.patchWorkspaceSession(selection)
  expect(f.state.workspaceSession).toMatchObject(selection)
})

it('admits renderer evidence only for an exact durably completed installed migration', async () => {
  const f = await fixture('worktree')
  const repo = { ...f.state.repos[0], id: 'unrelated-repo', connectionId: null }
  const migrationId = f.cutover.manifest.migrationId
  expect(() => requireOrcadRetirementRendererEvidence(f.runtime, migrationId)).toThrow('missing')
  f.install()
  expect(() => requireOrcadRetirementRendererEvidence(f.runtime, migrationId)).toThrow(
    'completion_required'
  )
  const completionEvidence = {
    version: 1,
    retirementRecordSha256: f.record.sha256,
    sourceRouteCheckpointSha256: 'b'.repeat(64)
  }
  const completed = createOrcadLiveCompletedCutover({
    committed: f.cutover,
    completionEvidence,
    retiredAt: '2026-09-08T12:00:00.000Z'
  })
  f.domains.orcadSourceRetirement.completeOrcadLiveRetirementProfile(f.record, completed, {
    completionEvidence,
    assertCurrent: () => {}
  })
  expect(() => requireOrcadRetirementRendererEvidence(f.runtime, migrationId)).toThrow(
    'completion_required'
  )
  f.runtime.orcadLiveCompletionDurability.acknowledge(
    OrcadLiveCompletionDurability.capture(f.state.orcadMigrationSourceCutovers)
  )
  f.domains.repos.addRepo(repo)
  expect(requireOrcadRetirementRendererEvidence(f.runtime, migrationId)).toEqual({
    record: f.record,
    completed
  })
  expect(() => requireOrcadRetirementRendererEvidence(f.runtime, 'foreign')).toThrow('missing')
  f.state.orcadMigrationSourceCutovers![0] = { ...completed, updatedAt: '2026-09-09T12:00:00.000Z' }
  expect(() => requireOrcadRetirementRendererEvidence(f.runtime, migrationId)).toThrow()
})

it.each(['patch', 'set', 'unload', 'host'] as const)(
  'allows ordinary catalog edits before %s publication after registry reload',
  async (entrypoint) => {
    const f = await fixture('worktree')
    const repo = { ...f.state.repos[0], id: 'unrelated-repo', connectionId: null }
    f.install()
    f.domains.repos.addRepo(repo)
    expect(new OrcadRetirementSessionPublication(f.directory).installedRecords(f.state)).toEqual([
      f.record
    ])
    const next = { ...f.state.workspaceSession, activeTabId: 'unrelated-tab' }
    if (entrypoint === 'patch') {
      f.domains.sessionSnapshots.patchWorkspaceSession({ activeTabId: next.activeTabId })
    } else if (entrypoint === 'unload') {
      f.domains.sessionSnapshots.stageWorkspaceSessionBeforeUnload(next)
      await f.runtime.pendingSnapshotFileWork
    } else {
      f.domains.sessionSnapshots.setWorkspaceSession(
        next,
        entrypoint === 'host' ? 'runtime:environment' : undefined
      )
    }
    const saved =
      entrypoint === 'host'
        ? f.state.workspaceSessionsByHostId!['runtime:environment']!
        : f.state.workspaceSession
    expect(saved.activeTabId).toBe(next.activeTabId)
    expect(f.state.repos).toContainEqual(repo)
    expect(
      f.domains.orcadSourceRetirement.inspectOrcadLiveRetirementProfileState(f.record).state
    ).toBe('conflict')
  }
)

it.each(['set', 'unload', 'host'] as const)(
  'reconciles full source replay through %s',
  async (entrypoint) => {
    const f = await fixture()
    const source = structuredClone(f.state.workspaceSessionsByHostId![f.hostId]!)
    f.install()
    if (entrypoint === 'unload') {
      f.domains.sessionSnapshots.stageWorkspaceSessionBeforeUnload(f.before)
      await f.runtime.pendingSnapshotFileWork
    } else {
      f.domains.sessionSnapshots.setWorkspaceSession(
        entrypoint === 'host' ? source : f.before,
        entrypoint === 'host' ? f.hostId : undefined
      )
    }
    expect(
      f.domains.orcadSourceRetirement.inspectOrcadLiveRetirementProfileState(f.record).state
    ).toBe('profile-installed')
    expect(f.state.workspaceSession.tabsByWorktree).toEqual({})
  }
)

it.each(['catalog', 'lease', 'recovery', 'journal', 'fence', 'source-session'] as const)(
  'rejects reappearing %s authority after unrelated catalog changes without mutation',
  async (kind) => {
    const f = await fixture('worktree')
    const original = structuredClone(f.state)
    f.install()
    f.domains.repos.addRepo({ ...original.repos[0], id: 'unrelated-repo', connectionId: null })
    if (kind === 'catalog') {
      f.state.repos.push(original.repos[0])
    }
    if (kind === 'lease') {
      f.state.sshRemotePtyLeases.push(original.sshRemotePtyLeases[0])
    }
    if (kind === 'recovery') {
      f.state.sshPtyConsumerRecoveries = original.sshPtyConsumerRecoveries
    }
    if (kind === 'journal') {
      f.state.orcadMigrationSourceCutovers = []
    }
    if (kind === 'fence') {
      f.state.sshTargets = []
    }
    if (kind === 'source-session') {
      f.state.workspaceSessionsByHostId!['runtime:environment'] = f.before
    }
    const before = structuredClone(f.state)
    const generation = f.runtime.writeGeneration
    expect(() =>
      f.domains.sessionSnapshots.patchWorkspaceSession({ activeTabId: 'unrelated-tab' })
    ).toThrow()
    expect(f.state).toEqual(before)
    expect(f.runtime.writeGeneration).toBe(generation)
    expect(f.runtime.pendingSnapshotFileWork).toBeNull()
  }
)

it('permits unrelated host leases and historical terminated source leases after catalog edits', async () => {
  const f = await fixture('worktree')
  const lease = { ...f.state.sshRemotePtyLeases[0], targetId: 'foreign' }
  const historical = {
    ...f.state.sshRemotePtyLeases[0],
    ptyId: 'historical-pty',
    state: 'terminated' as const
  }
  const repo = { ...f.state.repos[0], id: 'unrelated', connectionId: null }
  f.install()
  f.domains.repos.addRepo(repo)
  f.state.sshRemotePtyLeases.push(lease, historical)
  f.domains.sessionSnapshots.patchWorkspaceSession({ activeTabId: 'unrelated-tab' })
  expect(f.state.sshRemotePtyLeases).toContainEqual(lease)
  expect(f.state.sshRemotePtyLeases).toContainEqual(historical)
})

it('reconciles only recorded stale source data after ordinary catalog edits', async () => {
  const f = await fixture('worktree')
  const repo = { ...f.state.repos[0], id: 'unrelated', connectionId: null }
  f.install()
  f.domains.repos.addRepo(repo)
  f.domains.sessionSnapshots.setWorkspaceSession({ ...f.before, activeTabId: 'unrelated-tab' })
  expect(f.state.workspaceSession.tabsByWorktree).toEqual({})
  expect(f.state.workspaceSession.activeTabId).toBe('unrelated-tab')
  expect(f.state.repos).toContainEqual(repo)
})

it('retains rollback snapshot bytes during cleanup after unrelated catalog edits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-retirement-catalog-snapshot-'))
  directories.push(directory)
  const storage = { snapshotRoot: directory, fallbackSnapshotRoot: null }
  const ref = writeTerminalScrollbackSnapshotSync({
    tabId: 'unrelated-tab',
    leafId: 'leaf',
    buffer: 'rollback bytes',
    storage
  })!
  expect(ref).toBeTruthy()
  const f = await fixture('worktree', ref)
  const repo = { ...f.state.repos[0], id: 'unrelated-repo', connectionId: null }
  f.install()
  f.domains.repos.addRepo(repo)
  const before = structuredClone(f.state.workspaceSession)
  delete f.state.workspaceSession.terminalLayoutsByTabId['unrelated-tab']
  const retained = collectOrcadRetirementSnapshotRefs(f.runtime)
  expect(retained).toEqual(new Set([ref]))
  deleteRemovedTerminalScrollbackSnapshots(before, f.state.workspaceSession, storage, retained)
  expect(readTerminalScrollbackSnapshotSync(ref, storage)).toBe('rollback bytes')
})

it('rejects new PTY identity at an old source placement before side effects', async () => {
  const f = await fixture()
  f.install()
  const candidate = structuredClone(f.before)
  const layout = candidate.terminalLayoutsByTabId['tab-1']
  const leaf = Object.keys(layout.ptyIdsByLeafId!)[0]
  layout.ptyIdsByLeafId![leaf] = 'new-pty'
  const before = structuredClone(f.state)
  const generation = f.runtime.writeGeneration
  expect(() => f.domains.sessionSnapshots.setWorkspaceSession(candidate)).toThrow('replay_conflict')
  expect(f.state).toEqual(before)
  expect(f.runtime.writeGeneration).toBe(generation)
  expect(f.runtime.pendingSnapshotFileWork).toBeNull()
})

it('does not republish unload work queued before retirement installation', async () => {
  const f = await fixture()
  f.domains.sessionSnapshots.stageWorkspaceSessionBeforeUnload(f.before)
  // Capture evidence after normalization, before asynchronous snapshot-file publication.
  const record = f.domains.orcadSourceRetirement.createOrcadLiveSourceRetirementRecord(
    f.record.release,
    f.sourceAdmission
  )
  f.domains.orcadSourceRetirement.installOrcadLiveRetirementProfile(
    record,
    f.sourceAdmission,
    f.cutover.updatedAt
  )
  await f.runtime.pendingSnapshotFileWork
  expect(f.state.workspaceSession.tabsByWorktree).toEqual({})
  expect(f.domains.orcadSourceRetirement.inspectOrcadLiveRetirementProfileState(record).state).toBe(
    'profile-installed'
  )
})

it.each(['sync', 'async'] as const)(
  'retains rollback snapshot files during %s cleanup without retaining unrelated files',
  async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-retirement-snapshots-'))
    directories.push(directory)
    const storage = { snapshotRoot: directory, fallbackSnapshotRoot: null }
    const retained = writeTerminalScrollbackSnapshotSync({
      tabId: 'retired-tab',
      leafId: 'leaf',
      buffer: 'rollback output',
      storage
    })!
    const unrelated = writeTerminalScrollbackSnapshotSync({
      tabId: 'closed-tab',
      leafId: 'leaf',
      buffer: 'unrelated output',
      storage
    })!
    expect(retained).toBeTruthy()
    expect(unrelated).toBeTruthy()
    const prior = getDefaultWorkspaceSession()
    prior.terminalLayoutsByTabId = {
      'retired-tab': {
        root: { type: 'leaf', leafId: 'leaf' },
        activeLeafId: 'leaf',
        expandedLeafId: null,
        scrollbackRefsByLeafId: { leaf: retained }
      },
      'closed-tab': {
        root: { type: 'leaf', leafId: 'leaf' },
        activeLeafId: 'leaf',
        expandedLeafId: null,
        scrollbackRefsByLeafId: { leaf: unrelated }
      }
    }
    const cleanup =
      mode === 'sync'
        ? deleteRemovedTerminalScrollbackSnapshots
        : deleteRemovedTerminalScrollbackSnapshotsAsync
    await cleanup(prior, getDefaultWorkspaceSession(), storage, new Set([retained]))
    expect(readTerminalScrollbackSnapshotSync(retained, storage)).toBe('rollback output')
    expect(readTerminalScrollbackSnapshotSync(unrelated, storage)).toBeNull()
  }
)
