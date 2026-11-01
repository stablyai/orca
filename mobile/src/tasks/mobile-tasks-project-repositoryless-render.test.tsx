import type { ReactElement, ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import type { GitHubProjectRow } from './mobile-tasks-view-state-types'
import { renderMobileTasksGitHubProjectList } from './mobile-tasks-github-project-list'
import { renderMobileTasksProjectDetailDrawer } from './mobile-tasks-project-detail-drawer'

vi.mock('./mobile-tasks-dependencies', async () => {
  const { createElement } = await import('react')
  return {
    View: 'View',
    Pressable: 'Pressable',
    Text: 'Text',
    FlatList: ({
      data,
      renderItem
    }: {
      data: unknown[]
      renderItem: (input: { item: unknown }) => ReactNode
    }) => createElement('FlatList', null, ...data.map((item) => renderItem({ item }))),
    ActivityIndicator: 'ActivityIndicator',
    ChevronDown: 'ChevronDown',
    Plus: 'Plus',
    BottomDrawer: 'BottomDrawer',
    TaskProviderLogo: 'TaskProviderLogo',
    ExternalLink: 'ExternalLink',
    Copy: 'Copy',
    RefreshCw: 'RefreshCw',
    X: 'X',
    GitBranch: 'GitBranch',
    colors: {},
    spacing: { lg: 16 },
    Linking: { openURL: vi.fn() }
  }
})
vi.mock('lucide-react-native', () => ({ Inbox: 'Inbox' }))
vi.mock('../components/MobileStateView', () => ({
  MobileStateView: 'MobileStateView',
  MobileLoadErrorState: 'MobileLoadErrorState',
  MobileNoMatchState: 'MobileNoMatchState'
}))
vi.mock('./mobile-tasks-search-control', () => ({ clearMobileTasksSearch: vi.fn() }))
vi.mock('./mobile-tasks-legacy-styles', () => ({ styles: {} }))
vi.mock(
  '../components/list/ListGroup',
  async () => (await import('../test-support/settings-chrome-test-double')).listGroupDouble
)
// Real row labels and gates; only the drawer's flags and layering constant are fixed here.
vi.mock('./mobile-tasks-legacy-foundation', async () => ({
  ...(await import('./mobile-tasks-item-mapping')),
  ...(await import('./mobile-tasks-project-fields')),
  ...(await import('./mobile-tasks-repository-presentation')),
  TASK_SECONDARY_DRAWER_Z_INDEX: 20,
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

function row(id: string, itemType: GitHubProjectRow['itemType'], title: string): GitHubProjectRow {
  return {
    id,
    itemType,
    content: {
      number: null,
      title,
      body: null,
      url: null,
      state: null,
      isDraft: null,
      repository: null,
      labels: [],
      assignees: []
    },
    updatedAt: '2026-11-01T00:00:00Z'
  }
}

const draft = row('draft', 'DRAFT_ISSUE', 'Draft task')
const restricted = row('restricted', 'REDACTED', 'Restricted item')

function model(projectRowItem: GitHubProjectRow | null) {
  const rows = [draft, restricted]
  const state = {
    activeGitHubProject: { owner: 'qa', number: 1 },
    activeProjectLabel: 'QA Project',
    findProjectRowRepo: () => null,
    githubProjectError: null,
    githubProjectListEntries: rows.map((entry) => ({ type: 'row', row: entry })),
    githubProjectLoading: false,
    githubProjectRepoSlugReady: true,
    githubProjectSummaryFields: [],
    githubProjectTable: { project: { title: 'QA Project' }, rows },
    hasSearch: false,
    insets: { bottom: 0 },
    setProjectRowItem: vi.fn(),
    taskUiReady: true,
    visibleGitHubProjectRows: rows,
    projectRowItem,
    projectRowHandoff: { closeThen: vi.fn(), drawerProps: {} },
    projectIssueTypes: []
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this isolated fixture supplies the rendered fields; unrelated model branches are mocked above.
  return state as unknown as ConnectionPresentationModel
}

function texts(node: ReactTestInstance): string[] {
  return node
    .findAll((child) => String(child.type) === 'Text')
    .map((child) => child.children.filter((part) => typeof part === 'string').join(''))
}

describe('repositoryless GitHub Project items on the phone', () => {
  let renderer: ReactTestRenderer | undefined
  afterEach(() => act(() => renderer?.unmount()))
  function mount(element: ReactElement) {
    act(() => {
      renderer = create(element)
    })
    return renderer!
  }

  it('lists draft and restricted items with their status', () => {
    const list = mount(renderMobileTasksGitHubProjectList(model(null), 'light', 0))
    const rows = list.root.findAll((node) => String(node.type) === 'Pressable').map(texts)
    expect(rows.map((entry) => [entry[0], entry.at(-1)])).toEqual([
      ['Draft task', 'Draft'],
      ['Restricted item', 'Restricted']
    ])
  })

  it('shows a restricted item status in the detail drawer', () => {
    const drawer = mount(renderMobileTasksProjectDetailDrawer(model(restricted)))
    const drawerTexts = texts(drawer.root)
    expect(drawerTexts[drawerTexts.indexOf('Status') + 1]).toBe('Restricted')
  })
})
