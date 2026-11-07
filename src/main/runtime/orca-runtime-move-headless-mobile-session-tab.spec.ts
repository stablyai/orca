import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type {
  RuntimeMobileSessionTabMove,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'

export function registerOrcaRuntimeMoveHeadlessMobileSessionTabTests(): void {
  function terminalTab(parentTabId: string, isActive: boolean) {
    return {
      type: 'terminal' as const,
      id: `${parentTabId}::leaf-1`,
      parentTabId,
      leafId: 'leaf-1',
      title: 'Terminal',
      isActive
    }
  }

  function headlessRuntime(): {
    runtime: OrcaRuntimeService
    snapshots: Map<string, RuntimeMobileSessionTabsSnapshot>
  } {
    const runtime = new OrcaRuntimeService()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the published snapshot map is protected; seeding it stands in for a prior publication.
    const internals = runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    }
    const snapshots = internals.mobileSessionTabsByWorktree
    snapshots.set('wt-1', {
      worktree: 'wt-1',
      publicationEpoch: 'epoch-1',
      snapshotVersion: 1,
      activeGroupId: 'group-a',
      activeTabId: 'tab-a::leaf-1',
      activeTabType: 'terminal',
      tabGroups: [
        { id: 'group-a', activeTabId: 'tab-a', tabOrder: ['tab-a', 'tab-b'] },
        { id: 'group-c', activeTabId: 'tab-c', tabOrder: ['tab-c'] }
      ],
      tabGroupLayout: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'group-a' },
        second: { type: 'leaf', groupId: 'group-c' }
      },
      tabs: [terminalTab('tab-a', true), terminalTab('tab-b', false), terminalTab('tab-c', false)]
    })
    return { runtime, snapshots }
  }

  async function expectNoOp(move: RuntimeMobileSessionTabMove): Promise<void> {
    const { runtime, snapshots } = headlessRuntime()
    const before = snapshots.get('wt-1')
    await expect(runtime.moveMobileSessionTab('id:wt-1', move)).resolves.toEqual({ moved: true })
    expect(snapshots.get('wt-1')).toBe(before)
  }

  describe('headless session tab moves', () => {
    it('refuses a split onto a group the host does not have', async () => {
      const { runtime, snapshots } = headlessRuntime()
      const before = snapshots.get('wt-1')
      await expect(
        runtime.moveMobileSessionTab('id:wt-1', {
          kind: 'split',
          tabId: 'tab-b',
          targetGroupId: 'group-missing',
          splitDirection: 'right'
        })
      ).rejects.toThrow('target_group_not_found')
      expect(snapshots.get('wt-1')).toBe(before)
    })

    it('refuses a move into a group the host does not have', async () => {
      const { runtime, snapshots } = headlessRuntime()
      const before = snapshots.get('wt-1')
      await expect(
        runtime.moveMobileSessionTab('id:wt-1', {
          kind: 'move-to-group',
          tabId: 'tab-b',
          targetGroupId: 'group-missing'
        })
      ).rejects.toThrow('target_group_not_found')
      expect(snapshots.get('wt-1')).toBe(before)
    })

    it('keeps a same-group drop a successful no-op', async () => {
      await expectNoOp({ kind: 'move-to-group', tabId: 'tab-b', targetGroupId: 'group-a' })
    })

    it('keeps splitting the last tab off its own group a successful no-op', async () => {
      await expectNoOp({
        kind: 'split',
        tabId: 'tab-c',
        targetGroupId: 'group-c',
        splitDirection: 'right'
      })
    })
  })
}
