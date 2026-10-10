import { describe, expect, it, vi } from 'vitest'
import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  dismissTopMobileTasksDrawer,
  mobileTasksDrawerHostOpen,
  mobileTasksOpenDrawerCount
} from './mobile-tasks-drawer-host'

type DrawerTestOverrides = {
  actionItem?: { key: string }
  projectRowItem?: { id: string }
  projectRepoNotInOrca?: { owner: string; repo: string; url: null }
  pendingHostedStateChange?: { source: 'task' | 'project'; nextState: 'closed' }
  workspaceCreateDraft?: { item: { key: string } }
  workspaceSparseDraft?: { mode: 'new' }
  workspaceSparseSaving?: boolean
  showCreateTask?: boolean
  showCreateTargetPicker?: boolean
}

function model(overrides: DrawerTestOverrides = {}): ConnectionPresentationModel {
  const fixture = {
    taskUiReady: true,
    setPendingHostedStateChange: vi.fn(),
    setActionItem: vi.fn(),
    setProjectRowItem: vi.fn(),
    setProjectRepoNotInOrca: vi.fn(),
    setWorkspaceCreateDraft: vi.fn(),
    setWorkspaceSparseDraft: vi.fn(),
    setShowCreateTargetPicker: vi.fn(),
    setShowCreateTask: vi.fn(),
    workspaceSparseSaving: false,
    linearConnectState: 'idle',
    ...overrides
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This partial fixture supplies the presence flags and dismiss callbacks under test; opaque non-null item sentinels are never read and omitted drawers remain closed.
  return fixture as unknown as ConnectionPresentationModel
}

describe('mobile tasks drawer host', () => {
  it('stays closed when no sheet is open', () => {
    expect(mobileTasksDrawerHostOpen(model())).toBe(false)
  })

  it('opens for the issue detail sheet alone', () => {
    expect(mobileTasksDrawerHostOpen(model({ actionItem: { key: 'issue-1' } }))).toBe(true)
    expect(mobileTasksOpenDrawerCount(model({ actionItem: { key: 'issue-1' } }))).toBe(1)
  })

  it('counts a follow-up sheet stacked on the detail sheet', () => {
    expect(
      mobileTasksOpenDrawerCount(
        model({
          actionItem: { key: 'issue-1' },
          pendingHostedStateChange: { source: 'task', nextState: 'closed' }
        })
      )
    ).toBe(2)
  })

  it('stays open while a follow-up confirm is stacked on the detail sheet', () => {
    const current = model({
      actionItem: { key: 'issue-1' },
      pendingHostedStateChange: { source: 'task', nextState: 'closed' }
    })

    expect(mobileTasksDrawerHostOpen(current)).toBe(true)
  })

  it('closes the confirm before the issue detail', () => {
    const current = model({
      actionItem: { key: 'issue-1' },
      pendingHostedStateChange: { source: 'project', nextState: 'closed' }
    })

    dismissTopMobileTasksDrawer(current)

    expect(current.setPendingHostedStateChange).toHaveBeenCalledWith(null)
    expect(current.setActionItem).not.toHaveBeenCalled()
  })

  it('closes the issue detail when it is the only sheet', () => {
    const current = model({ projectRowItem: { id: 'row-1' } })

    dismissTopMobileTasksDrawer(current)

    expect(current.setProjectRowItem).toHaveBeenCalledWith(null)
  })

  it('dismisses the missing-repository warning before project detail', () => {
    const current = model({
      projectRowItem: { id: 'row-1' },
      projectRepoNotInOrca: { owner: 'stablyai', repo: 'orca', url: null }
    })
    expect(mobileTasksOpenDrawerCount(current)).toBe(2)
    dismissTopMobileTasksDrawer(current)
    expect(current.setProjectRepoNotInOrca).toHaveBeenCalledWith(null)
    expect(current.setProjectRowItem).not.toHaveBeenCalled()
  })

  it('closes the create-target picker before the create form', () => {
    const current = model({ showCreateTask: true, showCreateTargetPicker: true })

    dismissTopMobileTasksDrawer(current)

    expect(current.setShowCreateTargetPicker).toHaveBeenCalledWith(false)
    expect(current.setShowCreateTask).not.toHaveBeenCalled()
  })

  it('does not dismiss a sparse preset draft while it is saving', () => {
    const current = model({
      workspaceCreateDraft: { item: { key: 'issue-1' } },
      workspaceSparseDraft: { mode: 'new' },
      workspaceSparseSaving: true
    })

    dismissTopMobileTasksDrawer(current)

    expect(current.setWorkspaceSparseDraft).not.toHaveBeenCalled()
    expect(current.setWorkspaceCreateDraft).not.toHaveBeenCalled()
  })
})
