import { describe, expect, it, vi } from 'vitest'
import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  dismissTopMobileTasksDrawer,
  mobileTasksDrawerHostOpen,
  mobileTasksOpenDrawerCount
} from './mobile-tasks-drawer-host'

function model(overrides: Partial<ConnectionPresentationModel> = {}): ConnectionPresentationModel {
  return {
    taskUiReady: true,
    setPendingHostedStateChange: vi.fn(),
    setActionItem: vi.fn(),
    setProjectRowItem: vi.fn(),
    setWorkspaceCreateDraft: vi.fn(),
    setWorkspaceSparseDraft: vi.fn(),
    setShowCreateTargetPicker: vi.fn(),
    setShowCreateTask: vi.fn(),
    workspaceSparseSaving: false,
    linearConnectState: 'idle',
    ...overrides
  } as ConnectionPresentationModel
}

describe('mobile tasks drawer host', () => {
  it('stays closed when no sheet is open', () => {
    expect(mobileTasksDrawerHostOpen(model())).toBe(false)
  })

  it('opens for the issue detail sheet alone', () => {
    expect(mobileTasksDrawerHostOpen(model({ actionItem: { key: 'issue-1' } as never }))).toBe(true)
    expect(mobileTasksOpenDrawerCount(model({ actionItem: { key: 'issue-1' } as never }))).toBe(1)
  })

  it('counts a follow-up sheet stacked on the detail sheet', () => {
    expect(
      mobileTasksOpenDrawerCount(
        model({
          actionItem: { key: 'issue-1' } as never,
          pendingHostedStateChange: { source: 'task', nextState: 'closed' } as never
        })
      )
    ).toBe(2)
  })

  it('stays open while a follow-up confirm is stacked on the detail sheet', () => {
    const current = model({
      actionItem: { key: 'issue-1' } as never,
      pendingHostedStateChange: { source: 'task', nextState: 'closed' } as never
    })

    expect(mobileTasksDrawerHostOpen(current)).toBe(true)
  })

  it('closes the confirm before the issue detail', () => {
    const current = model({
      actionItem: { key: 'issue-1' } as never,
      pendingHostedStateChange: { source: 'project', nextState: 'closed' } as never
    })

    dismissTopMobileTasksDrawer(current)

    expect(current.setPendingHostedStateChange).toHaveBeenCalledWith(null)
    expect(current.setActionItem).not.toHaveBeenCalled()
  })

  it('closes the issue detail when it is the only sheet', () => {
    const current = model({ projectRowItem: { id: 'row-1' } as never })

    dismissTopMobileTasksDrawer(current)

    expect(current.setProjectRowItem).toHaveBeenCalledWith(null)
  })

  it('closes the create-target picker before the create form', () => {
    const current = model({ showCreateTask: true, showCreateTargetPicker: true })

    dismissTopMobileTasksDrawer(current)

    expect(current.setShowCreateTargetPicker).toHaveBeenCalledWith(false)
    expect(current.setShowCreateTask).not.toHaveBeenCalled()
  })

  it('does not dismiss a sparse preset draft while it is saving', () => {
    const current = model({
      workspaceCreateDraft: { item: { key: 'issue-1' } } as never,
      workspaceSparseDraft: { mode: 'new' } as never,
      workspaceSparseSaving: true
    })

    dismissTopMobileTasksDrawer(current)

    expect(current.setWorkspaceSparseDraft).not.toHaveBeenCalled()
    expect(current.setWorkspaceCreateDraft).not.toHaveBeenCalled()
  })
})
