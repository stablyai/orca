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

  it('reconciles nothing for a session without terminal rows', () => {
    const reconcile = vi.fn()
    expect(reconcileHydratedWorkspaceTabModels({ tabsByWorktree: {} }, reconcile)).toEqual([])
    expect(reconcile).not.toHaveBeenCalled()
  })
})
