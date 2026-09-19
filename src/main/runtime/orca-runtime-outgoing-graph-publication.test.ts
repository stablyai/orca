import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { fenceOutgoingPtyRegistrations } from './outgoing-pty-registration-fence'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { HEADLESS_RUNTIME_WINDOW_ID, type RuntimeSyncWindowGraph } from '../../shared/runtime-types'

const sourceId = toAppSshPtyId('source', 'pty')
function graph(ptyId: string | null, worktreeId: string): RuntimeSyncWindowGraph {
  return {
    tabs: [{ tabId: 'tab', worktreeId, title: 'Terminal', activeLeafId: 'leaf', layout: null }],
    leaves: [{ tabId: 'tab', worktreeId, leafId: 'leaf', paneRuntimeId: 1, ptyId }]
  }
}

function state(runtime: OrcaRuntimeService) {
  return runtime as unknown as {
    authoritativeWindowId: number | null
    tabs: Map<string, unknown>
    leaves: Map<string, unknown>
    ptysById: Map<string, unknown>
    handleByPtyId: Map<string, unknown>
  }
}

it.each([1, HEADLESS_RUNTIME_WINDOW_ID])(
  'refuses stale source graph before claiming window %s authority',
  (windowId) => {
    const runtime = new OrcaRuntimeService()
    fenceOutgoingPtyRegistrations(runtime, [sourceId])
    expect(() => runtime.syncWindowGraph(windowId, graph(sourceId, 'folder:source'))).toThrow(
      'source_graph_publication_fenced'
    )
    expect(state(runtime).authoritativeWindowId).toBeNull()
    expect(state(runtime).tabs.size).toBe(0)
    expect(state(runtime).leaves.size).toBe(0)
    expect(state(runtime).ptysById.size).toBe(0)
  }
)

it.each(['folder:source', 'repo::/host/worktree'])(
  'preserves held source graph against replay, omission and rebinding (%s)',
  (workspace) => {
    const runtime = new OrcaRuntimeService()
    runtime.syncWindowGraph(1, graph(sourceId, workspace))
    const before = state(runtime)
    const tabs = before.tabs
    const leaves = before.leaves
    const pty = before.ptysById.get(sourceId)
    const handles = [...before.handleByPtyId]
    const exit = vi.spyOn(runtime, 'onPtyExit')
    fenceOutgoingPtyRegistrations(runtime, [sourceId])
    for (const next of [
      graph(sourceId, workspace),
      graph(null, workspace),
      graph(toAppSshPtyId('destination', 'pty'), workspace),
      { tabs: [], leaves: [] }
    ]) {
      expect(() => runtime.syncWindowGraph(1, next)).toThrow('source_graph_publication_fenced')
      expect(state(runtime).tabs).toBe(tabs)
      expect(state(runtime).leaves).toBe(leaves)
      expect(state(runtime).ptysById.get(sourceId)).toBe(pty)
      expect([...state(runtime).handleByPtyId]).toEqual(handles)
    }
    expect(exit).not.toHaveBeenCalled()
  }
)

it('allows graph publication for another target and in another runtime', () => {
  const runtime = new OrcaRuntimeService()
  fenceOutgoingPtyRegistrations(runtime, [sourceId])
  expect(() =>
    runtime.syncWindowGraph(1, graph(toAppSshPtyId('other', 'pty'), 'folder:other'))
  ).not.toThrow()
  const other = new OrcaRuntimeService()
  expect(() => other.syncWindowGraph(1, graph(sourceId, 'folder:source'))).not.toThrow()
})
