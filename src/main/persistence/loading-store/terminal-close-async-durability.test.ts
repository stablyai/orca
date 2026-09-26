import { expect, it, vi } from 'vitest'
import { fixture } from './profile-state-delayed-authority-fixture'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-types'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

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
    await this.closeHeadlessMobileTerminalTab(binding.worktreeId, snapshot, tab)
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
  const closing = runtime.closeTerminalSurfaceFromRenderer(binding.worktreeId, target).then(() => {
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

  // Nothing rolled the removal back, so the next write makes it durable.
  await store.flushPendingOrThrowAsync()
  expect(persistedLeafIds()).toEqual([])
})

it('keeps a renderer close when its durable write fails', async () => {
  const { authority, runtime, persistedLeafIds, liveLeafIds } = await closeFixture()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const gate = authority.pause()
  const closing = runtime.closeTerminalSurfaceFromRenderer(binding.worktreeId, {
    kind: 'tab',
    tabId: binding.tabId
  })
  await Promise.race([gate.started.promise, closing])
  gate.finish.reject(new Error('close disk refused'))

  await expect(closing).resolves.toBeUndefined()
  expect(liveLeafIds()).toEqual([])
  expect(persistedLeafIds()).toEqual([binding.leafId])
})

it('commits nothing for a pane that restarted while its close waited for the writer', async () => {
  const { authority, store, runtime, liveLeafIds } = await closeFixture({ split: true })
  const gate = authority.pause()
  const session = store.getWorkspaceSession()
  store.setWorkspaceSession({ ...session, activeTabIdByWorktree: { [binding.worktreeId]: null } })
  const earlierWrite = store.flushPendingOrThrowAsync()
  await gate.started.promise
  // The restart is queued first, so it lands after the close captured the pane it meant.
  const restart = store.persistPtyBinding({
    ...binding,
    ptyId: 'restarted-pty',
    incarnationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  })
  const closing = runtime.closeTerminalSurfaceFromRenderer(binding.worktreeId, {
    kind: 'pane',
    tabId: binding.tabId,
    leafId: binding.leafId
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
  // The split's binding is queued first, so it grows the tab after the close was asked.
  const split = store.persistPtyBinding({
    ...binding,
    leafId: siblingLeafId,
    ptyId: 'sibling-pty',
    incarnationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    expectedSourceBinding: binding
  })
  const closing = runtime.closeTerminalSurfaceFromRenderer(binding.worktreeId, {
    kind: 'tab',
    tabId: binding.tabId
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
})
