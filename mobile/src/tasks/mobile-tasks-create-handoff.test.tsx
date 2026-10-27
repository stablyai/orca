import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { BottomDrawer, PickerModal, Pressable } from './mobile-tasks-dependencies'
import { renderMobileTasksItemActions } from './mobile-tasks-item-actions'
import { renderMobileTasksWorkspaceCreateTargetPicker } from './mobile-tasks-create-drawers'
import { renderMobileTasksProjectDetailDrawer } from './mobile-tasks-project-detail-drawer'

vi.mock('./mobile-tasks-dependencies', () => ({
  View: 'View',
  Pressable: 'Pressable',
  Text: 'Text',
  Plus: 'Plus',
  BottomDrawer: 'BottomDrawer',
  PickerModal: 'PickerModal',
  TaskProviderLogo: 'TaskProviderLogo',
  ExternalLink: 'ExternalLink',
  Copy: 'Copy',
  RefreshCw: 'RefreshCw',
  X: 'X',
  GitBranch: 'GitBranch',
  colors: {},
  Linking: { openURL: vi.fn() }
}))
vi.mock('./mobile-tasks-legacy-styles', () => ({ styles: {} }))
vi.mock('./mobile-tasks-legacy-foundation', () => ({
  TASK_SECONDARY_DRAWER_Z_INDEX: 20,
  taskExternalOpenLabel: () => 'Open',
  taskStatusActionLabel: () => 'Close',
  isGitHubPrMergeBlocked: () => false,
  canCreateWorkspaceFromProjectRow: () => true,
  projectRowType: () => 'issue',
  projectRowStatusLabel: () => 'Open',
  SHOW_MOBILE_DETAIL_LABEL_CHIPS: false,
  SHOW_MOBILE_PROJECT_METADATA_EDITORS: false
}))
vi.mock('./mobile-tasks-project-field-editors', () => ({
  renderMobileTasksProjectFieldEditors: () => null
}))
vi.mock('./mobile-tasks-project-metadata-editors', () => ({
  renderMobileTasksProjectLabelsEditor: () => null,
  renderMobileTasksProjectAssigneesEditor: () => null
}))
vi.mock('./mobile-tasks-project-detail-content', () => ({
  renderMobileTasksProjectLoadedDetail: () => null
}))

function model(provider: string) {
  let pending: (() => void) | undefined
  const close = vi.fn()
  const handoff = {
    closeThen(action: () => void) {
      pending = action
      close()
    },
    drawerProps: {
      onClose: close,
      onAfterClose() {
        const action = pending
        pending = undefined
        action?.()
      }
    }
  }
  const item = { key: 'issue', provider, source: { state: 'closed', url: 'https://example.com/1' } }
  const state = {
    actionItem: item,
    workspaceRepoPickerItem: item,
    workspaceRepos: [{ id: 'repo-a' }, { id: 'repo-b' }],
    workspaceRepoOptions: [],
    taskUiReady: true,
    taskDetailHandoff: handoff,
    repoPickerHandoff: handoff,
    projectRowHandoff: handoff,
    openWorkspaceCreate: vi.fn(),
    setWorkspaceRepoPickerItem: vi.fn(),
    createWorkspaceFromProjectRow: vi.fn(),
    projectRowItem: {
      id: 'row',
      itemType: 'ISSUE',
      content: { title: 'Issue', url: 'https://example.com/1', labels: [] }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this isolated fixture supplies the rendered fields; unrelated model branches are mocked above.
  const presentation = state as unknown as ConnectionPresentationModel
  return { state, presentation, handoff, close }
}

describe('Tasks create source handoffs', () => {
  let renderer: ReactTestRenderer | undefined
  afterEach(() => act(() => renderer?.unmount()))
  function mount(element: ReturnType<typeof createElement> | null) {
    if (!element) {
      throw new Error('Expected a source action')
    }
    act(() => {
      renderer = create(element)
    })
    return renderer!
  }
  it.each(['github', 'linear', 'jira'])(
    'queues %s create or repository selection through the supplied handoff',
    (provider) => {
      const { state, presentation, handoff, close } = model(provider)
      const rendered = mount(renderMobileTasksItemActions(presentation))
      act(() => rendered.root.findAllByType(Pressable)[0].props.onPress())
      expect(close).toHaveBeenCalledOnce()
      expect(state.openWorkspaceCreate).not.toHaveBeenCalled()
      expect(state.setWorkspaceRepoPickerItem).not.toHaveBeenCalled()
      act(() => handoff.drawerProps.onAfterClose())
      if (provider === 'github') {
        expect(state.openWorkspaceCreate).toHaveBeenCalledWith(state.actionItem)
      } else {
        expect(state.setWorkspaceRepoPickerItem).toHaveBeenCalledWith(state.actionItem)
      }
    }
  )
  it('queues the selected repository through the supplied picker handoff', () => {
    const { state, presentation, handoff, close } = model('jira')
    const rendered = mount(renderMobileTasksWorkspaceCreateTargetPicker(presentation))
    act(() => rendered.root.findByType(PickerModal).props.onSelect('repo-b'))
    expect(close).toHaveBeenCalledOnce()
    expect(state.openWorkspaceCreate).not.toHaveBeenCalled()
    act(() => handoff.drawerProps.onAfterClose())
    expect(state.openWorkspaceCreate).toHaveBeenCalledWith(state.workspaceRepoPickerItem, 'repo-b')
  })
  it('queues project row creation through the supplied drawer handoff', () => {
    const { state, presentation, handoff, close } = model('github')
    const rendered = mount(renderMobileTasksProjectDetailDrawer(presentation))
    act(() => rendered.root.findAllByType(Pressable)[0].props.onPress())
    expect(close).toHaveBeenCalledOnce()
    expect(state.createWorkspaceFromProjectRow).not.toHaveBeenCalled()
    act(() => handoff.drawerProps.onAfterClose())
    expect(state.createWorkspaceFromProjectRow).toHaveBeenCalledWith(state.projectRowItem)
    expect(rendered.root.findByType(BottomDrawer).props.onAfterClose).toBe(
      handoff.drawerProps.onAfterClose
    )
  })
})
