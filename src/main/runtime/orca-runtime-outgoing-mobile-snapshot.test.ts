import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { fenceOutgoingPtyRegistrations } from './outgoing-pty-registration-fence'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'

const sourceId = toAppSshPtyId('source', 'pty')
function snapshot(parentOnly = false, ptyId = sourceId): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: 'folder:source',
    publicationEpoch: 'renderer',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabGroups: [],
    tabs: [
      {
        type: 'terminal',
        id: 'tab::leaf',
        parentTabId: 'tab',
        leafId: 'leaf',
        ptyId: parentOnly ? null : ptyId,
        title: 'Terminal',
        isActive: false,
        ...(parentOnly
          ? {
              parentLayout: {
                root: { type: 'leaf' as const, leafId: 'leaf' },
                activeLeafId: 'leaf',
                expandedLeafId: null,
                ptyIdsByLeafId: { leaf: ptyId }
              }
            }
          : {})
      }
    ]
  }
}
class Runtime extends OrcaRuntimeService {
  storeSnapshot(value: RuntimeMobileSessionTabsSnapshot) {
    return this.storeMobileSessionSnapshot(value.worktree, value)
  }
  syncSnapshots(values: RuntimeMobileSessionTabsSnapshot[]) {
    return this.syncMobileSessionTabs(values)
  }
  state() {
    return {
      authority: this.authoritativeWindowId,
      tabs: this.tabs,
      snapshots: this.mobileSessionTabsByWorktree,
      accepted: this.acceptedRendererMobileSnapshotByWorktree
    }
  }
}

it.each([false, true])(
  'refuses stale mobile bindings before graph authority (parent-only=%s)',
  (parentOnly) => {
    const runtime = new Runtime()
    fenceOutgoingPtyRegistrations(runtime, [sourceId])
    const incoming = snapshot(parentOnly)
    expect(() =>
      runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [incoming] })
    ).toThrow('source_mobile_snapshot_fenced')
    expect(runtime.state().authority).toBeNull()
    expect(runtime.state().tabs.size).toBe(0)
    expect(runtime.state().snapshots.size).toBe(0)
    expect(runtime.state().accepted.size).toBe(0)
    expect(() => runtime.storeSnapshot(incoming)).toThrow('source_mobile_snapshot_fenced')
    expect(() => runtime.syncSnapshots([incoming])).toThrow('source_mobile_snapshot_fenced')
  }
)

it('refuses snapshot omission and replacement without changing the held source snapshot', () => {
  const runtime = new Runtime()
  const held = runtime.storeSnapshot(snapshot())
  fenceOutgoingPtyRegistrations(runtime, [sourceId])
  const replacement = { ...held, tabs: [] }
  expect(() => runtime.storeSnapshot(replacement)).toThrow('source_mobile_snapshot_fenced')
  expect(() => runtime.syncSnapshots([])).toThrow('source_mobile_snapshot_fenced')
  expect(() => runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })).toThrow(
    'source_mobile_snapshot_fenced'
  )
  expect(runtime.state().snapshots.get(held.worktree)).toBe(held)
  expect(runtime.state().authority).toBeNull()
})

it('allows an independent target and runtime snapshot', () => {
  const runtime = new Runtime()
  fenceOutgoingPtyRegistrations(runtime, [sourceId])
  expect(() => runtime.storeSnapshot(snapshot(true, toAppSshPtyId('other', 'pty')))).not.toThrow()
  expect(() => new Runtime().storeSnapshot(snapshot())).not.toThrow()
})

it('skips background snapshot touches without publishing or bumping the held version', () => {
  const runtime = new Runtime()
  const held = runtime.storeSnapshot(snapshot(true))
  const notify = vi.spyOn(runtime, 'notifyMobileSessionTabsChanged')
  fenceOutgoingPtyRegistrations(runtime, [sourceId])
  expect(() => runtime.touchMobileSessionTabsForWorktree(held.worktree)).not.toThrow()
  expect(() =>
    runtime.touchMobileSessionTabsForWorktree(held.worktree, { immediate: true })
  ).not.toThrow()
  expect(runtime.state().snapshots.get(held.worktree)).toBe(held)
  expect(notify).not.toHaveBeenCalled()
})
