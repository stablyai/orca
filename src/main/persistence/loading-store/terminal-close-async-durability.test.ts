import { beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { _resetClosedPaneFencesForTests } from '../terminal-topology/closed-pane-binding-fence'
import { fixture } from './profile-state-delayed-authority-fixture'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-types'
import { writeTerminalScrollbackSnapshotSync } from '../../pty/scrollback/terminal-scrollback-snapshots'
import { orcadMigrationCutoverFixture } from '../../ssh/orcad-migration-cutover-fixture'
import { computeOrcadMigrationManifestSha256 } from '../../orcad/orcad-migration-manifest-digest'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

// Clear process-wide close fences because these tests reuse pane IDs.
beforeEach(_resetClosedPaneFencesForTests)

const binding = {
  worktreeId: 'repo-local::/fixture/local',
  tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ptyId: 'closing-pty',
  incarnationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
}
const siblingLeafId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

class CloseRuntime extends OrcaRuntimeService {
  async closeHeadlessTab(): Promise<void> {
    const snapshot = this.mobileSessionTabsByWorktree.get(binding.worktreeId)
    const tab = snapshot?.tabs[0]
    if (!snapshot || tab?.type !== 'terminal') {
      throw new Error('missing test tab')
    }
    await this.closeHeadlessMobileTerminalTab(binding.worktreeId, tab.parentTabId)
  }
  publish(): void {
    const snapshot: RuntimeMobileSessionTabsSnapshot = {
      worktree: binding.worktreeId,
      publicationEpoch: 'close-test',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: `${binding.tabId}::${binding.leafId}`,
      activeTabType: 'terminal',
      tabs: [
        {
          type: 'terminal',
          id: `${binding.tabId}::${binding.leafId}`,
          parentTabId: binding.tabId,
          leafId: binding.leafId,
          ptyId: binding.ptyId,
          title: 'Terminal',
          isActive: true
        }
      ]
    }
    this.storeMobileSessionSnapshot(binding.worktreeId, snapshot)
  }
}

async function closeFixture(options: { split?: boolean } = {}) {
  const result = await fixture()
  await result.store.persistPtyBinding(binding)
  if (options.split) {
    await result.store.persistPtyBinding({
      ...binding,
      leafId: siblingLeafId,
      ptyId: 'sibling-pty',
      incarnationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      expectedSourceBinding: binding
    })
  }
  const runtime = new CloseRuntime(result.store)
  const kill = vi.fn(() => true)
  runtime.setPtyController({ write: () => true, kill, getForegroundProcess: async () => null })
  return {
    ...result,
    runtime,
    kill,
    persistedLeafIds: () =>
      Object.keys(
        result.readState().workspaceSession.terminalLayoutsByTabId[binding.tabId]?.ptyIdsByLeafId ??
          {}
      ),
    liveLeafIds: () =>
      Object.keys(
        result.store.getWorkspaceSession().terminalLayoutsByTabId[binding.tabId]?.ptyIdsByLeafId ??
          {}
      )
  }
}

function saveScrollback(store: Awaited<ReturnType<typeof fixture>>['store']): string {
  // Remote terminals retain renderer-captured files, including legacy copies in the local slice.
  store.updateRepo({ id: 'repo-local' }, { executionHostId: 'ssh:build-host' })
  const ref = writeTerminalScrollbackSnapshotSync({
    ...binding,
    buffer: 'recover this terminal output',
    storage: { snapshotRoot: join(store.getProfileStorageDirectory(), 'terminal-scrollback') }
  })
  if (!ref) {
    throw new Error('fixture snapshot write failed')
  }
  const session = store.getWorkspaceSession()
  const layout = session.terminalLayoutsByTabId[binding.tabId]
  store.setWorkspaceSession({
    ...session,
    terminalLayoutsByTabId: {
      ...session.terminalLayoutsByTabId,
      [binding.tabId]: { ...layout, scrollbackRefsByLeafId: { [binding.leafId]: ref } }
    }
  })
  return ref
}

it.each([
  ['tab', { kind: 'tab' as const, tabId: binding.tabId }, []],
  [
    'split pane',
    { kind: 'pane' as const, tabId: binding.tabId, leafId: binding.leafId },
    [siblingLeafId]
  ]
])('acknowledges a renderer %s close only once it is durable', async (kind, target, remaining) => {
  const { authority, runtime, persistedLeafIds } = await closeFixture({ split: kind !== 'tab' })
  const before = persistedLeafIds()
  const gate = authority.pause()
  let acknowledged = false
  const closing = runtime
    .closeTerminalSurfaceFromRenderer({ worktreeId: binding.worktreeId, target: target })
    .then(() => {
      acknowledged = true
    })
  try {
    await Promise.race([gate.started.promise, closing])
    expect(acknowledged).toBe(false)
    expect(persistedLeafIds()).toEqual(before)
  } finally {
    gate.finish.resolve()
  }
  await closing
  expect(persistedLeafIds()).toEqual(remaining)
})

it('keeps a phone close and still kills when its durable write fails', async () => {
  const { authority, store, runtime, kill, persistedLeafIds, liveLeafIds } = await closeFixture()
  runtime.registerPty(binding.ptyId, binding.worktreeId, null, binding)
  runtime.publish()
  const failure = vi.spyOn(console, 'error').mockImplementation(() => {})
  const gate = authority.pause()
  const closing = runtime.closeHeadlessTab()
  await Promise.race([gate.started.promise, closing])
  gate.finish.reject(new Error('close disk refused'))

  await expect(closing).resolves.toBeUndefined()
  expect(kill).toHaveBeenCalledExactlyOnceWith(binding.ptyId)
  expect(liveLeafIds()).toEqual([])
  expect(persistedLeafIds()).toEqual([binding.leafId])
  expect(failure).toHaveBeenCalledWith(
    '[runtime] failed to persist terminal close:',
    expect.objectContaining({ message: 'close disk refused' })
  )

  await store.flushPendingOrThrowAsync()
  expect(persistedLeafIds()).toEqual([])
})

it('keeps a renderer close when its durable write fails', async () => {
  const { authority, runtime, persistedLeafIds, liveLeafIds } = await closeFixture()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const gate = authority.pause()
  const closing = runtime.closeTerminalSurfaceFromRenderer({
    worktreeId: binding.worktreeId,
    target: {
      kind: 'tab',
      tabId: binding.tabId
    }
  })
  await Promise.race([gate.started.promise, closing])
  gate.finish.reject(new Error('close disk refused'))

  await expect(closing).resolves.toBeUndefined()
  expect(liveLeafIds()).toEqual([])
  expect(persistedLeafIds()).toEqual([binding.leafId])
})

it('preserves the saved tab and resume record when its owner changes during the write', async () => {
  const { authority, store, runtime, kill, readState, persistedLeafIds, liveLeafIds } =
    await closeFixture()
  const paneKey = `${binding.tabId}:${binding.leafId}`
  const ref = saveScrollback(store)
  const otherTabId = '11111111-1111-4111-8111-111111111111'
  await store.persistPtyBinding({
    ...binding,
    tabId: otherTabId,
    leafId: '22222222-2222-4222-8222-222222222222',
    ptyId: 'other-pty'
  })
  const resume = {
    paneKey,
    tabId: binding.tabId,
    worktreeId: binding.worktreeId,
    agent: 'codex' as const,
    providerSession: { key: 'session_id' as const, id: 'close-resume' },
    prompt: '',
    state: 'done' as const,
    capturedAt: 1,
    updatedAt: 1
  }
  store.setWorkspaceSession({
    ...store.getWorkspaceSession(),
    sleepingAgentSessionsByPaneKey: { [paneKey]: resume }
  })
  await store.flushPendingOrThrowAsync()
  runtime.registerPty(binding.ptyId, binding.worktreeId, null, binding)
  runtime.publish()
  const gate = authority.pause()
  const closing = runtime.closeHeadlessTab()
  const refused = expect(closing).rejects.toThrow('terminal_pane_owner_changed')
  await Promise.race([gate.started.promise, closing])
  expect.soft(store.readTerminalScrollbackSnapshot(ref)).toBe('recover this terminal output')
  const concurrent = store.getWorkspaceSession()
  store.setWorkspaceSession({
    ...concurrent,
    closedTerminalTabTombstonesByTabId: {
      ...concurrent.closedTerminalTabTombstonesByTabId,
      // ast-grep-ignore: test-no-wall-clock -- Tombstones are pruned against the real clock, so this concurrent one must be current.
      'other-closed-tab': { worktreeId: binding.worktreeId, closedAt: Date.now(), reason: 'user' }
    },
    tabsByWorktree: {
      ...concurrent.tabsByWorktree,
      [binding.worktreeId]: concurrent.tabsByWorktree[binding.worktreeId].map((tab) => ({
        ...tab,
        customTitle: 'renamed while closing'
      }))
    }
  })
  runtime.registerPty(binding.ptyId, binding.worktreeId, null, {
    ...binding,
    incarnationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  })
  const recovery = authority.pause()
  gate.finish.resolve()
  try {
    await Promise.race([recovery.started.promise, refused])
    expect.soft(store.readTerminalScrollbackSnapshot(ref)).toBe('recover this terminal output')
    expect.soft(liveLeafIds()).toEqual([binding.leafId])
    expect.soft(persistedLeafIds()).toEqual([])
  } finally {
    recovery.finish.resolve()
  }
  await refused
  expect(kill).not.toHaveBeenCalled()
  expect.soft(liveLeafIds()).toEqual([binding.leafId])
  expect.soft(persistedLeafIds()).toEqual([binding.leafId])
  expect
    .soft(readState().workspaceSession.sleepingAgentSessionsByPaneKey?.[paneKey])
    .toEqual(resume)
  expect(store.readTerminalScrollbackSnapshot(ref)).toBe('recover this terminal output')
  expect(
    readState().workspaceSession.terminalLayoutsByTabId[binding.tabId].scrollbackRefsByLeafId
  ).toEqual({ [binding.leafId]: ref })
  expect(readState().workspaceSession.tabsByWorktree[binding.worktreeId]).toContainEqual(
    expect.objectContaining({ id: otherTabId, customTitle: 'renamed while closing' })
  )
  expect(readState().workspaceSession.tabsByWorktree[binding.worktreeId]).toContainEqual(
    expect.objectContaining({ id: binding.tabId })
  )
  expect(
    readState().workspaceSession.closedTerminalTabTombstonesByTabId?.[binding.tabId]
  ).toBeUndefined()
  expect(
    readState().workspaceSession.closedTerminalTabTombstonesByTabId?.['other-closed-tab']
  ).toBeDefined()
})

it('releases the scrollback file only after accepting the durable close', async () => {
  const { authority, store, runtime, kill } = await closeFixture()
  const ref = saveScrollback(store)
  await store.flushPendingOrThrowAsync()
  runtime.registerPty(binding.ptyId, binding.worktreeId, null, binding)
  runtime.publish()
  const gate = authority.pause()
  const closing = runtime.closeHeadlessTab()
  await Promise.race([gate.started.promise, closing])
  expect.soft(store.readTerminalScrollbackSnapshot(ref)).toBe('recover this terminal output')
  expect.soft(kill).not.toHaveBeenCalled()
  gate.finish.resolve()
  await closing
  expect(kill).toHaveBeenCalledExactlyOnceWith(binding.ptyId)
  expect(store.readTerminalScrollbackSnapshot(ref)).toBeNull()
})

it('keeps its own file hold when a migration releases the same snapshot during the write', async () => {
  const { authority, store, runtime, kill } = await closeFixture()
  const ref = saveScrollback(store)
  const { manifestSha256: _hash, ...manifest } = orcadMigrationCutoverFixture().manifest
  const buffer = 'recover this terminal output'
  manifest.payload = {
    ...manifest.payload,
    dormantState: {
      version: 1,
      worktreeMeta: [],
      worktreeLineage: [],
      workspaceLineage: [],
      sparsePresets: [],
      retiredWorktreeNames: [],
      retiredWorktreeNamespaces: [],
      workspaceSession: store.getWorkspaceSession(),
      terminalScrollbackSnapshots: [
        {
          tabId: binding.tabId,
          leafId: binding.leafId,
          ref,
          sha256: createHash('sha256').update(buffer).digest('hex'),
          byteLength: Buffer.byteLength(buffer)
        }
      ]
    }
  }
  store.syncOrcadMigrationScrollbackRetention([
    { ...manifest, manifestSha256: computeOrcadMigrationManifestSha256(manifest) }
  ])
  await store.flushPendingOrThrowAsync()
  runtime.registerPty(binding.ptyId, binding.worktreeId, null, binding)
  runtime.publish()
  const gate = authority.pause()
  const closing = runtime.closeHeadlessTab()
  const refused = expect(closing).rejects.toThrow('terminal_pane_owner_changed')
  try {
    await Promise.race([gate.started.promise, closing])
    store.syncOrcadMigrationScrollbackRetention([])
    expect.soft(store.readTerminalScrollbackSnapshot(ref)).toBe(buffer)
    runtime.registerPty(binding.ptyId, binding.worktreeId, null, {
      ...binding,
      incarnationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    })
  } finally {
    gate.finish.resolve()
  }
  await refused
  expect(kill).not.toHaveBeenCalled()
  expect(store.readTerminalScrollbackSnapshot(ref)).toBe(buffer)
})

it('keeps recovery data dirty if persisting the compensation fails', async () => {
  const { authority, store, runtime, kill, liveLeafIds, persistedLeafIds } = await closeFixture()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const ref = saveScrollback(store)
  await store.flushPendingOrThrowAsync()
  runtime.registerPty(binding.ptyId, binding.worktreeId, null, binding)
  runtime.publish()
  const gate = authority.pause()
  const closing = runtime.closeHeadlessTab()
  const refused = expect(closing).rejects.toThrow('terminal_pane_owner_changed')
  await Promise.race([gate.started.promise, closing])
  runtime.registerPty(binding.ptyId, binding.worktreeId, null, {
    ...binding,
    incarnationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  })
  const recovery = authority.pause()
  gate.finish.resolve()
  await Promise.race([recovery.started.promise, closing])
  recovery.finish.reject(new Error('compensation disk refused'))
  await refused
  expect(kill).not.toHaveBeenCalled()
  expect(liveLeafIds()).toEqual([binding.leafId])
  expect(persistedLeafIds()).toEqual([])
  expect(store.readTerminalScrollbackSnapshot(ref)).toBe('recover this terminal output')
  await store.flushPendingOrThrowAsync()
  expect(persistedLeafIds()).toEqual([binding.leafId])
})

it('restores a rejected close even when its initial disk write fails', async () => {
  const { authority, store, runtime, kill, liveLeafIds, persistedLeafIds } = await closeFixture()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const ref = saveScrollback(store)
  await store.flushPendingOrThrowAsync()
  runtime.registerPty(binding.ptyId, binding.worktreeId, null, binding)
  runtime.publish()
  const gate = authority.pause()
  const closing = runtime.closeHeadlessTab()
  const refused = expect(closing).rejects.toThrow('terminal_pane_owner_changed')
  await Promise.race([gate.started.promise, closing])
  runtime.registerPty(binding.ptyId, binding.worktreeId, null, {
    ...binding,
    incarnationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  })
  gate.finish.reject(new Error('close disk refused'))
  await refused
  expect(kill).not.toHaveBeenCalled()
  expect(liveLeafIds()).toEqual([binding.leafId])
  expect(persistedLeafIds()).toEqual([binding.leafId])
  expect(store.readTerminalScrollbackSnapshot(ref)).toBe('recover this terminal output')
})

it('commits nothing for a pane that restarted while its close waited for the writer', async () => {
  const { authority, store, runtime, liveLeafIds } = await closeFixture({ split: true })
  const gate = authority.pause()
  const session = store.getWorkspaceSession()
  store.setWorkspaceSession({ ...session, activeTabIdByWorktree: { [binding.worktreeId]: null } })
  const earlierWrite = store.flushPendingOrThrowAsync()
  await gate.started.promise
  // Queue restart before close executes to test stale-close ownership fencing.
  const restart = store.persistPtyBinding({
    ...binding,
    ptyId: 'restarted-pty',
    incarnationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  })
  const closing = runtime.closeTerminalSurfaceFromRenderer({
    worktreeId: binding.worktreeId,
    target: {
      kind: 'pane',
      tabId: binding.tabId,
      leafId: binding.leafId
    }
  })
  gate.finish.resolve()
  await earlierWrite
  await expect(restart).resolves.toBe(true)
  await closing

  expect(liveLeafIds()).toEqual([binding.leafId, siblingLeafId])
})

it('commits a renderer tab close whose split pane bound while the close waited for the writer', async () => {
  const { authority, store, runtime, persistedLeafIds, liveLeafIds } = await closeFixture()
  const gate = authority.pause()
  const session = store.getWorkspaceSession()
  store.setWorkspaceSession({ ...session, activeTabIdByWorktree: { [binding.worktreeId]: null } })
  const earlierWrite = store.flushPendingOrThrowAsync()
  await gate.started.promise
  // Queue the split before close executes to test a sibling added after capture.
  const split = store.persistPtyBinding({
    ...binding,
    leafId: siblingLeafId,
    ptyId: 'sibling-pty',
    incarnationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    expectedSourceBinding: binding
  })
  const closing = runtime.closeTerminalSurfaceFromRenderer({
    worktreeId: binding.worktreeId,
    target: {
      kind: 'tab',
      tabId: binding.tabId
    }
  })
  gate.finish.resolve()
  await earlierWrite
  await expect(split).resolves.toBe(true)
  await expect(closing).resolves.toBeUndefined()

  expect(persistedLeafIds()).toEqual([])
  expect(liveLeafIds()).toEqual([])
  expect(
    store
      .getWorkspaceSession()
      .tabsByWorktree[binding.worktreeId]?.some((tab) => tab.id === binding.tabId)
  ).toBe(false)
  expect(store.getWorkspaceSession().closedTerminalTabTombstonesByTabId?.[binding.tabId]).toEqual(
    expect.objectContaining({ worktreeId: binding.worktreeId, reason: 'user' })
  )
})
