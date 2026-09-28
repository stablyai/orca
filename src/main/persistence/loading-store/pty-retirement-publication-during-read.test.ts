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
  ptyId: 'retiring-pty',
  incarnationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
}
class RetirementRuntime extends OrcaRuntimeService {
  readVisibleState() {
    return this.readVisibleTerminalState(binding.ptyId)
  }
  snapshot(): RuntimeMobileSessionTabsSnapshot | undefined {
    return this.mobileSessionTabsByWorktree.get(binding.worktreeId)
  }
  generations(): number {
    return this.ptyLifecycleGenerationById.size
  }
  retirements(): number {
    return this.pendingPtySurfaceRetirementsByPtyId.size
  }
  async closeTab(): Promise<void> {
    const snapshot = this.snapshot()
    const tab = snapshot?.tabs[0]
    if (!snapshot || tab?.type !== 'terminal') {
      throw new Error('missing test tab')
    }
    await this.closeHeadlessMobileTerminalTab(binding.worktreeId, snapshot, tab)
  }
  publish(layoutOnly = false): void {
    this.storeMobileSessionSnapshot(binding.worktreeId, {
      worktree: binding.worktreeId,
      publicationEpoch: 'retirement-test',
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
          ptyId: layoutOnly ? null : binding.ptyId,
          ...(layoutOnly
            ? {
                parentLayout: {
                  root: { type: 'leaf' as const, leafId: binding.leafId },
                  activeLeafId: binding.leafId,
                  expandedLeafId: null,
                  ptyIdsByLeafId: { [binding.leafId]: binding.ptyId }
                }
              }
            : {}),
          title: 'Terminal',
          isActive: true
        }
      ]
    })
  }
}

it.each(['read', 'replacement', 'legacy-replacement'] as const)(
  'publishes an exited terminal retirement with concurrent %s',
  async (action) => {
    const { store, authority, readState } = await fixture()
    await store.persistPtyBinding(binding)
    const runtime = new RetirementRuntime(store)
    runtime.registerPty(binding.ptyId, binding.worktreeId, null, binding)
    runtime.publish()
    const gate = authority.pause()
    const exiting = runtime.onPtyExit(binding.ptyId, 0, binding.incarnationId, {
      providerExitObserved: true
    })
    await gate.started.promise
    if (action === 'read') {
      await runtime.readVisibleState()
    } else if (action === 'legacy-replacement') {
      runtime.onPtySpawned(binding.ptyId)
    } else {
      runtime.onPtySpawned(binding.ptyId, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')
    }
    gate.finish.resolve()
    await exiting
    expect(readState().workspaceSession.terminalLayoutsByTabId[binding.tabId]).toBeUndefined()
    expect(runtime.snapshot()?.tabs).toHaveLength(action === 'read' ? 0 : 1)
    if (action === 'read') {
      expect(runtime.retirements()).toBe(0)
    }
  }
)

it('publishes an exit whose only live ownership is the mobile parent layout', async () => {
  const { store, authority, readState } = await fixture()
  await store.persistPtyBinding(binding)
  const runtime = new RetirementRuntime(store)
  runtime.publish(true)
  const gate = authority.pause()
  const exiting = runtime.onPtyExit(binding.ptyId, 0, binding.incarnationId, {
    providerExitObserved: true
  })
  await gate.started.promise
  gate.finish.resolve()
  await exiting
  expect(readState().workspaceSession.terminalLayoutsByTabId[binding.tabId]).toBeUndefined()
  expect(runtime.snapshot()?.tabs).toEqual([])
  expect(runtime.generations()).toBe(0)
})

it('completes a durable close and refuses a split queued behind it', async () => {
  const { store, authority, readState } = await fixture()
  await store.persistPtyBinding(binding)
  const runtime = new RetirementRuntime(store)
  const kill = vi.fn(() => true)
  runtime.setPtyController({ write: () => true, kill, getForegroundProcess: async () => null })
  runtime.registerPty(binding.ptyId, binding.worktreeId, null, binding)
  runtime.publish()
  const gate = authority.pause()
  const close = runtime.closeTab()
  await gate.started.promise
  const split = store.persistPtyBinding({
    ...binding,
    leafId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    ptyId: 'concurrent-split',
    expectedSourceBinding: binding
  })
  gate.finish.resolve()
  await close
  await expect(split).resolves.toBe(false)
  expect(kill).toHaveBeenCalledExactlyOnceWith(binding.ptyId)
  expect(runtime.snapshot()?.tabs).toEqual([])
  expect(readState().workspaceSession.terminalLayoutsByTabId[binding.tabId]).toBeUndefined()
})
