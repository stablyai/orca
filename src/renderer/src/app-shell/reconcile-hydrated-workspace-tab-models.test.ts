import { describe, expect, it, vi } from 'vitest'
import { reconcileHydratedWorkspaceTabModels } from './reconcile-hydrated-workspace-tab-models'

describe('reconcileHydratedWorkspaceTabModels', () => {
  it('reconciles every workspace the session hydrated, in session order, in one call', () => {
    const reconcile = vi.fn()
    const reconciled = reconcileHydratedWorkspaceTabModels(
      { tabsByWorktree: { 'wt-a': [], 'wt-b': [], 'wt-c': [] } },
      reconcile
    )
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(reconcile.mock.calls[0]?.[0]).toEqual(['wt-a', 'wt-b', 'wt-c'])
    expect(reconciled).toEqual(['wt-a', 'wt-b', 'wt-c'])
  })

  it('reconciles editor-only workspaces that have unified tabs but no terminal rows', () => {
    const reconcile = vi.fn()
    const reconciled = reconcileHydratedWorkspaceTabModels(
      { tabsByWorktree: { 'wt-a': [] }, unifiedTabs: { 'wt-a': [], 'wt-editor-only': [] } },
      reconcile
    )
    expect(reconcile).toHaveBeenCalledTimes(1)
    // Shared keys are reconciled once; terminal-row keys keep their order.
    expect(reconciled).toEqual(['wt-a', 'wt-editor-only'])
  })

  it('reconciles nothing for a session with neither terminal rows nor unified tabs', () => {
    const reconcile = vi.fn()
    expect(reconcileHydratedWorkspaceTabModels({ tabsByWorktree: {} }, reconcile)).toEqual([])
    expect(reconcile).not.toHaveBeenCalled()
  })
})
