import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reconcileHydratedWorkspaceTabModels } from './reconcile-hydrated-workspace-tab-models'

const hoisted = vi.hoisted(() => ({
  layoutOwnerIsMain: false,
  showServerLayoutFrames: vi.fn(),
  showStartupLayoutFrames: vi.fn()
}))

vi.mock('../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return hoisted.layoutOwnerIsMain
  }
}))
vi.mock('../runtime/server-layout-frames', () => ({
  showServerLayoutFrames: hoisted.showServerLayoutFrames
}))
vi.mock('../runtime/workspace-layout-frame-sync', () => ({
  showStartupLayoutFrames: hoisted.showStartupLayoutFrames
}))
vi.mock('../runtime/sleeping-records-to-layout-owner', () => ({
  followSleepingRecordsInLayoutOwner: vi.fn()
}))

describe('paired servers’ layout streams at restore', () => {
  beforeEach(() => {
    hoisted.showServerLayoutFrames.mockReset()
    hoisted.showStartupLayoutFrames.mockReset()
  })

  it('open with the layout-owner switch on', () => {
    hoisted.layoutOwnerIsMain = true
    reconcileHydratedWorkspaceTabModels({ tabsByWorktree: { 'wt-a': [] } }, vi.fn())
    expect(hoisted.showStartupLayoutFrames).toHaveBeenCalledTimes(1)
    expect(hoisted.showServerLayoutFrames).toHaveBeenCalledTimes(1)
  })

  it('never open with the switch off, though restore reconciled', () => {
    hoisted.layoutOwnerIsMain = false
    const reconcile = vi.fn()
    reconcileHydratedWorkspaceTabModels({ tabsByWorktree: { 'wt-a': [] } }, reconcile)
    expect(reconcile).toHaveBeenCalledWith(['wt-a'])
    expect(hoisted.showServerLayoutFrames).not.toHaveBeenCalled()
    expect(hoisted.showStartupLayoutFrames).not.toHaveBeenCalled()
  })
})
