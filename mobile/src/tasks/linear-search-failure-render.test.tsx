import { useEffect, useMemo, useRef, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { useMobileTasksTaskListLoading } from './use-mobile-tasks-task-list-loading'
import { MobileTasksLegacySurface } from './MobileTasksLegacySurface'
import type { ProviderLoadActionsModel } from './use-mobile-tasks-provider-load-actions'
import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SmartWorkspaceSourceDrawer } from '../components/SmartWorkspaceSourceDrawer'
import { useMobileComposerSource } from './use-mobile-composer-source'
import { credentialDecryptionMessage } from '../../../src/shared/integration-credential-errors'
import type { RpcClient } from '../transport/rpc-client'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'

const rpc = vi.hoisted(() => ({ message: '' }))
vi.mock('react-native', async () => {
  const { createElement } = await import('react')
  const View = ({ children }: { children?: React.ReactNode }) =>
    createElement('div', null, children)
  return {
    Text: ({ children }: { children?: React.ReactNode }) => createElement('span', null, children),
    View,
    Pressable: ({ children, onPress }: { children?: React.ReactNode; onPress: () => void }) =>
      createElement('button', { onClick: onPress }, children),
    TextInput: () => null,
    FlatList: () => null,
    ActivityIndicator: () => null,
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    InteractionManager: { runAfterInteractions: () => ({ cancel: () => {} }) }
  }
})
vi.mock('../components/BottomDrawer', () => ({
  BottomDrawer: ({ children }: { children: unknown }) => children
}))
vi.mock('../components/SmartSourceModeIcon', () => ({ SmartSourceModeIcon: () => null }))
vi.mock('../components/nav-bar/SheetHeader', () => ({ SheetHeader: () => null }))
vi.mock('../components/SmartWorkspaceSourceRow', () => ({ SmartWorkspaceSourceRow: () => null }))

// Server-side SDK → handler → error-envelope cases run in the desktop Linear auth suite.
// This RN consumer uses that envelope shape, including raw messages from older servers.
const client: RpcClient = {
  ...createFakeRpcClient(),
  sendRequest: async (method) => {
    expect(method).toBe('linear.searchIssues')
    return { id: '1', ok: false, error: { code: 'runtime_error', message: rpc.message } }
  }
}
let rendered: ReactTestRenderer
const text = () => JSON.stringify(rendered.toJSON())
async function mount(element: React.ReactElement) {
  await act(async () => {
    rendered = create(element)
  })
}
async function expectText(value: string) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
  expect(text()).toContain(value)
}
const availability = {
  textOnly: false,
  tasksSupported: true,
  hasRepo: false,
  githubAvailable: false,
  gitlabAvailable: false,
  linearAvailable: true,
  jiraAvailable: false
}
const repos: [] = []
function Picker() {
  const composer = useMobileComposerSource({ client, selectedRepoId: null })
  useEffect(() => composer.setName('network issue'), [composer.setName])
  return (
    <SmartWorkspaceSourceDrawer
      visible
      client={client}
      composer={composer}
      availability={availability}
      repoId={null}
      repos={repos}
      linearWorkspaceId="w"
      sshReady={false}
      onRepoChange={() => {}}
      onClose={() => {}}
    />
  )
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  act(() => rendered?.unmount())
  vi.useRealTimers()
  vi.restoreAllMocks()
})
it.each([
  ['401 private provider diagnostic', 'Unable to load Linear issues. Try again.'],
  ['429: GraphQL request failed private diagnostic', 'Unable to load Linear issues. Try again.'],
  [credentialDecryptionMessage('Linear'), credentialDecryptionMessage('Linear')]
])('renders the server failure envelope safely: %s', async (raw, visible) => {
  rpc.message = raw
  await mount(<Picker />)
  await act(async () => {
    rendered.root
      .findAllByType('button')
      .find((button) =>
        button.findAllByType('span').some((label) => label.children.includes('Linear'))
      )!
      .props.onClick()
  })
  await expectText(visible)
  if (raw !== visible) {
    expect(text()).not.toContain(raw)
  }
})

vi.mock('./mobile-tasks-dependencies', async () => {
  const react = await import('react')
  const View = ({ children }: { children?: React.ReactNode }) =>
    react.createElement('div', null, children)
  return {
    ...react,
    View,
    Text: View,
    SafeAreaView: View,
    BottomDrawerModalHost: View,
    ActionSheetModal: () => null,
    ConfirmModal: () => null,
    AlertTriangle: () => null,
    GitBranch: () => null,
    colors: {},
    useMobileColorScheme: () => 'light'
  }
})
vi.mock('./mobile-tasks-legacy-styles', () => ({ styles: {} }))
vi.mock('./mobile-tasks-legacy-foundation', () => ({ LINEAR_LIMIT: 100 }))
vi.mock('./mobile-tasks-screen-chrome', () => ({ renderMobileTasksChrome: () => null }))
vi.mock('./mobile-tasks-list-surface', () => ({ renderMobileTasksListSurface: () => null }))
vi.mock('./mobile-tasks-search-control', () => ({
  mobileTasksSearchVisible: () => true,
  renderMobileTasksSearchControl: () => null
}))
vi.mock('./mobile-tasks-filter-sheet', () => ({ renderMobileTasksFilterSheet: () => null }))
vi.mock('./mobile-tasks-provider-pickers', () => ({
  renderMobileTasksRepoPicker: () => null,
  renderMobileTasksGitHubIssueSourcePicker: () => null,
  renderMobileTasksGitHubViewPicker: () => null,
  renderMobileTasksGitHubPresetPicker: () => null,
  renderMobileTasksPagePicker: () => null
}))
vi.mock('./mobile-tasks-github-project-pickers', () => ({
  renderMobileTasksGitHubProjectPicker: () => null,
  renderMobileTasksGitHubProjectViewPicker: () => null
}))
vi.mock('./mobile-tasks-filter-pickers', () => ({
  renderMobileTasksGitHubProjectFieldsPicker: () => null,
  renderMobileTasksGitLabViewPicker: () => null,
  renderMobileTasksGitLabFilterPicker: () => null,
  renderMobileTasksJiraFilterPicker: () => null,
  renderMobileTasksJiraSitePicker: () => null,
  renderMobileTasksLinearFilterPicker: () => null,
  renderMobileTasksLinearWorkspacePicker: () => null,
  renderMobileTasksLinearTeamPicker: () => null,
  renderMobileTasksLinearStatusPicker: () => null
}))
vi.mock('./mobile-tasks-list-display-pickers', () => ({
  renderMobileTasksLinearDisplayPicker: () => null
}))
vi.mock('./mobile-tasks-create-drawers', () => ({
  renderMobileTasksCreateDrawer: () => null,
  renderMobileTasksCreateTargetPicker: () => null,
  renderMobileTasksLinearConnectDrawer: () => null,
  renderMobileTasksWorkspaceCreateTargetPicker: () => null
}))
vi.mock('./mobile-tasks-workspace-create-drawer', () => ({
  renderMobileTasksWorkspaceCreateDrawer: () => null,
  renderMobileTasksWorkspaceCreateRepoPicker: () => null,
  renderMobileTasksWorkspaceAgentPicker: () => null
}))
vi.mock('./mobile-tasks-workspace-option-pickers', () => ({
  renderMobileTasksWorkspaceBaseBranchPicker: () => null,
  renderMobileTasksWorkspaceSparsePicker: () => null
}))
vi.mock('./mobile-tasks-workspace-trust-drawers', () => ({
  renderMobileTasksWorkspaceSparseDrawer: () => null,
  renderMobileTasksSetupTrustDrawer: () => null,
  renderMobileTasksOrcaYamlTrustDrawer: () => null
}))
vi.mock('./mobile-tasks-project-detail-drawer', () => ({
  renderMobileTasksProjectMissingRepoDrawer: () => null,
  renderMobileTasksProjectDetailDrawer: () => null
}))
vi.mock('./mobile-tasks-item-detail-drawer', () => ({
  MobileTasksItemDetailDrawer: () => null
}))
function Tasks() {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const clientRef = useRef(client),
    loadGenerationRef = useRef(0)
  const model = useMemo(
    () => ({
      appliedQuery: 'network issue',
      client,
      clientRef,
      loadGenerationRef,
      connState: 'connected',
      tasksSupported: true,
      taskStateHydrated: true,
      provider: 'linear',
      linearConnected: true,
      linearFilter: 'all',
      selectedLinearWorkspaceId: 'w',
      selectedLinearTeamIds: new Set<string>(),
      linearOrderBy: 'updatedAt',
      effectiveRepoIds: new Set<string>(),
      serverRepoList: [],
      repoListEnsureLoaded: async () => [],
      resetGitHubItemsState: () => {},
      setError,
      setLoading,
      setRefreshing: () => {},
      setItems: () => {}
    }),
    [clientRef, loadGenerationRef, setError, setLoading]
  )
  // SAFETY: the actual Linear search branch uses precisely these fields; unrelated screen controls are omitted.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the production phone search surface reads the explicitly supplied RPC/list dependencies; unrelated mobile screen services are intentionally inert.
  const actions = useMobileTasksTaskListLoading(model as unknown as ProviderLoadActionsModel)
  useEffect(() => {
    void actions.loadTasks()
  }, [])
  // SAFETY: shipping error banner reads error/provider/loading; unrelated drawers/chrome are mocked above.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the production phone search surface reads the explicitly supplied RPC/list dependencies; unrelated mobile screen services are intentionally inert.
  const presentation = { ...actions, error, loading } as unknown as ConnectionPresentationModel
  return <MobileTasksLegacySurface model={presentation} />
}
it('shipping phone Tasks renders the safe server search failure', async () => {
  const raw = '429: GraphQL request failed private phone Tasks diagnostic'
  rpc.message = raw
  await mount(<Tasks />)
  await expectText('Unable to load Linear issues. Try again.')
  expect(text()).not.toContain(raw)
})
