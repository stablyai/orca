// @vitest-environment happy-dom
import React, { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MobilePRSidebar } from '@orca/test-mobile/components/MobilePRSidebar'
import {
  createFakeRpcClient,
  rpcSuccess
} from '@orca/test-mobile/mobile-web-shell/bridge-host-test-fakes'
import { createStableLogicalRpcClient } from '@orca/test-mobile/transport/stable-logical-rpc-client'
import type { HostConnectionInputs } from '@orca/test-mobile/transport/client-context-connection-metrics'
import type { TextField } from '@orca/test-mobile/components/composer-input/TextField'
import { RuntimeGitHubRepositoryQueryCommands } from '@orca/test-host/main/runtime/runtime-github-repository-query-commands'
import { GITHUB_REPO_WORK_ITEM_METHODS } from '@orca/test-host/main/runtime/rpc/methods/github-repo-work-item-methods'
import type { OrcaRuntimeService } from '@orca/test-host/main/runtime/orca-runtime'
import { eraseRpcMethods } from '@orca/test-host/main/runtime/rpc/core'
import type { GitHubWorkItemDetails } from '@orca/test-host/shared/github/work-item-types'
import type { Repo } from '@orca/test-host/shared/repo-types'
type SearchField = { value?: string; onChangeText?: (text: string) => void }
const io = vi.hoisted(
  (): {
    gh: ReturnType<typeof vi.fn>
    resolved: ReturnType<typeof vi.fn>
    requestReviewer: ReturnType<typeof vi.fn>
    // The sheet's real search field, as the thin native adapter last received it.
    search: SearchField | null
  } => ({ gh: vi.fn(), resolved: vi.fn(), requestReviewer: vi.fn(), search: null })
)
vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  View: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  ScrollView: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  Text: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
  TextInput: () => <input />,
  ActivityIndicator: () => <span role="progressbar" />,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    disabled
  }: React.PropsWithChildren<{
    onPress: () => void
    accessibilityLabel?: string
    disabled?: boolean
  }>) => (
    <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  )
}))
vi.mock('lucide-react-native', () =>
  Object.fromEntries(
    [
      'ArrowRight',
      'CircleCheck',
      'CircleDashed',
      'CircleMinus',
      'CircleX',
      'GitMerge',
      'LoaderCircle',
      'MessageCircle',
      'MoreHorizontal',
      'RotateCw',
      'Search',
      'X'
    ].map((name) => [name, () => null])
  )
)
// Thin native adapters: the drawer finishes its hide at once, rows and the header forward presses.
vi.mock('../../components/bottom-drawer/mounted-bottom-drawer', async () => {
  const { useLayoutEffect } = await import('react')
  return {
    MountedBottomDrawer: ({
      visible,
      children,
      onHidden
    }: React.PropsWithChildren<{ visible: boolean; onHidden: () => void }>) => {
      useLayoutEffect(() => {
        if (!visible) {
          onHidden()
        }
      }, [visible, onHidden])
      return <div data-sheet="">{children}</div>
    }
  }
})
vi.mock('../../components/list/ListGroup', () => ({
  LIST_LEADING_INSET: 0,
  ListGroup: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  ListRow: ({
    title,
    onPress,
    detail,
    accessory
  }: {
    title: string
    onPress?: () => void
    detail?: React.ReactNode
    accessory?: React.ReactNode
  }) => (
    <div>
      <button aria-label={title} onClick={onPress}>
        {title}
      </button>
      {detail}
      {accessory}
    </div>
  )
}))
vi.mock('../../components/nav-bar/SheetHeader', () => ({
  SheetHeader: ({
    title,
    trailing
  }: {
    title: string
    trailing?: { label: string; onPress: () => void }
  }) => (
    <div>
      <span>{title}</span>
      {trailing ? <button aria-label={trailing.label} onClick={trailing.onPress} /> : null}
    </div>
  )
}))
vi.mock('../../components/composer-input/TextField', () => ({
  TextField: (props: ComponentProps<typeof TextField>) => {
    io.search = props
    return <input readOnly value={props.value} placeholder={props.placeholder} />
  }
}))
vi.mock('../../components/nav-bar/NavBarButton', () => ({ NavBarButton: () => null }))
vi.mock('../../components/nav-bar/PullDownMenu', () => ({ PullDownMenu: () => null }))
vi.mock('../../components/pr-sidebar/use-pr-tab-menu', () => ({ usePrTabMenuGroups: () => null }))
vi.mock('../../components/pr-sidebar/PrTabEmptyState', () => ({ PrTabEmptyState: () => null }))
vi.mock('../../components/pr-sidebar/PrTabOverviewCards', () => ({
  PrChangesCard: () => null,
  PrDescription: () => null
}))
vi.mock('../../components/pr-sidebar/PrTabBottomAction', () => ({ PrTabBottomAction: () => null }))
vi.mock('../../components/pr-sidebar/PrTabScreenView', () => ({ PrTabScreenView: () => null }))
vi.mock('../../components/pr-sidebar/PrCreateSheet', () => ({ PrCreateSheet: () => null }))
vi.mock('../../components/ConfirmModal', () => ({ ConfirmModal: () => null }))
vi.mock('../../components/SheetPrimaryButton', () => ({ SheetPrimaryButton: () => null }))
vi.mock('../../components/composer-input/FieldTextInput', () => ({ FieldTextInput: () => null }))
vi.mock('../../components/MobileStateView', () => ({
  MobileStateView: () => null,
  MobileLoadErrorState: () => null
}))
vi.mock('../../components/mobile-pr-url', () => ({ openMobilePrUrl: () => {} }))
vi.mock('../../navigation/use-back-claim', () => ({ useBackClaim: () => {} }))
vi.mock('../../hooks/use-now', () => ({ useNow: () => 0, useAppActive: () => true }))
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return { useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) }
})
vi.mock('../../components/pr-sidebar/mobile-pr-sidebar-styles', () => ({
  mobilePrSidebarStyles: {}
}))
vi.mock('../../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'dark' }))
vi.mock('../../i18n/use-mobile-translation', () => ({
  useMobileTranslation:
    () => (_key: string, fallback: string, args?: Record<string, string | number>) =>
      fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(args?.[name] ?? ''))
}))
vi.mock(
  '../../../../src/main/github/client',
  async () => import('@orca/test-host/main/github/issue-field-options')
)
vi.mock('../../../../src/main/github/gh-utils', () => ({
  ghExecFileAsync: io.gh,
  acquire: async () => {},
  release: () => {}
}))
vi.mock('../../../../src/main/github/github-api-repository', () => ({
  resolveGitHubRepoExecution: io.resolved
}))
vi.mock('../../../../src/main/github/gh-account-binding-inventory', () => ({}))
vi.mock('../../../../src/main/github/account-binding-required-host', () => ({}))
vi.mock('../../../../src/main/github/rate-limit', () => ({}))
vi.mock('../../../../src/main/github/work-item-details', () => ({}))
vi.mock('../../session/use-mobile-pr-actions', () => ({
  useMobilePrActions: () => ({
    blocked: null,
    error: null,
    resolveReviewerRequested: (_login: string, value: boolean) => value,
    resolveState: (state: string) => state,
    isBusy: () => false,
    requestReviewer: io.requestReviewer,
    removeReviewer: vi.fn()
  })
}))
vi.mock('../../session/use-mobile-pr-comment-actions', () => ({
  useMobilePrCommentActions: () => ({})
}))
vi.mock('../../session/use-mobile-pr-text-action', () => ({
  useMobilePrTextAction: () => ({ clearError: () => {}, saving: false, error: null })
}))
vi.mock('../../session/use-mobile-pr-ai-triage', () => ({
  useMobilePrAiTriage: () => ({ isBusy: () => false, noticeFor: () => ({}), availability: 'ready' })
}))
vi.mock('../../components/host-protocol-gates-context', () => ({
  useHostProtocolGates: () => ({ hostCapabilities: [], statusPending: false, statusReadable: true })
}))
vi.mock('../../session/use-pr-bot-author-overrides', () => ({
  usePRBotAuthorOverrides: () => new Set()
}))
let root: ReturnType<typeof createRoot> | undefined
afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = undefined
  io.search = null
  vi.unstubAllGlobals()
})
it('real tab/sheet sends a searched fork to the runtime provider with original worktree/account, supports refusal/reopen/migration, and keeps one visit rows across connection changes', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const prRepo = { owner: 'fork', repo: 'widgets', host: 'github.corp' }
  const repo: Repo = {
    id: 'clone',
    path: '/clone',
    displayName: 'clone',
    badgeColor: '',
    addedAt: 0,
    connectionId: 'nested-ssh',
    ghAccount: { host: 'github.corp', user: 'selected-account' },
    issueSourcePreference: 'upstream'
  }
  const resolved = vi.fn(async (selector: string) => {
    expect(selector).toBe('id:clone')
    return repo
  })
  const commands = new RuntimeGitHubRepositoryQueryCommands({
    resolveRepo: resolved,
    getLocalGitArgs: (selected) => [{ ghAccount: selected.ghAccount }]
  })
  io.resolved.mockImplementation(async (_path, target, connection, options) => {
    expect(connection).toBe('nested-ssh')
    expect(options.ghAccount).toEqual(repo.ghAccount)
    return { ownerRepo: target, ghOptions: options }
  })
  io.gh.mockReset().mockImplementation(async (args: string[]) => ({
    stdout: JSON.stringify({
      login: args.some((arg) => arg.includes('repos/fork/')) ? 'fork-only' : 'upstream-only',
      avatar_url: ''
    })
  }))
  const physical = createFakeRpcClient()
  let capable = false
  const frames: string[] = []
  let hold = false
  const held: { release: () => void; fail: () => void }[] = []
  const method = eraseRpcMethods(GITHUB_REPO_WORK_ITEM_METHODS).find(
    (entry) => entry.name === 'github.listAssignableUsers'
  )!
  if (!method.params) {
    throw new Error('missing list schema')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selected production method uses only listRepoAssignableUsers on this runtime boundary.
  const runtime = {
    listRepoAssignableUsers: commands.listRepoAssignableUsers.bind(commands)
  } as unknown as OrcaRuntimeService
  physical.sendRequest = async (name, params, options) => {
    options?.beforeSend?.()
    frames.push(name)
    if (name === 'status.get') {
      return rpcSuccess('status', {
        runtimeId: 'S',
        hostDescriptor: { installationId: 'S' },
        capabilities: capable ? ['github.exact-work-item-target.v1'] : []
      })
    }
    if (name !== 'github.listAssignableUsers') {
      throw new Error(`unexpected ${name}`)
    }
    const reply = async () =>
      rpcSuccess('users', await method.handler(method.params!.parse(params), { runtime }))
    if (!hold) {
      return reply()
    }
    // A held list reply runs the provider only when released, so each release picks its own gh output.
    return new Promise<ReturnType<typeof rpcSuccess>>((resolve, reject) => {
      held.push({
        release: () => void reply().then(resolve, reject),
        fail: () => reject(new Error('socket closed'))
      })
    })
  }
  const logical = createStableLogicalRpcClient(physical, 'relay')
  io.requestReviewer.mockReset()
  const details: GitHubWorkItemDetails = {
    item: {
      id: 'pr:93',
      type: 'pr',
      number: 93,
      title: 'fork',
      url: 'https://github.corp/fork/widgets/pull/93',
      prRepo,
      state: 'open',
      labels: [],
      author: null,
      updatedAt: ''
    },
    body: '',
    comments: []
  }
  const container = document.createElement('div')
  root = createRoot(container)
  // The screen header's verdict inputs; a relay verdict overrides them where a step sets one.
  let relay: Partial<HostConnectionInputs> = {}
  const renderSidebar = (target: typeof prRepo, worktreeId: string) =>
    root!.render(
      <MobilePRSidebar
        client={logical}
        hostConnection={{
          reconnectAttempts: 0,
          lastConnectedAt: null,
          pendingPath: null,
          pairingRejected: false,
          relayHostReachability: 'connecting',
          ...relay
        }}
        state={{
          kind: 'ready',
          data: {
            pr: {
              number: 93,
              state: 'open',
              title: 'fork',
              url: `https://github.corp/${target.owner}/widgets/pull/93`,
              prRepo: target,
              checksStatus: 'success',
              updatedAt: '',
              mergeable: 'MERGEABLE'
            },
            details: { ...details, item: { ...details.item, prRepo: target } },
            checks: [],
            checksError: null,
            pushTarget: null
          }
        }}
        connState="connected"
        onRetry={() => {}}
        refetch={() => {}}
        worktreeId={worktreeId}
        gitBranch="feature"
        gitStatus={null}
        headSha={null}
        workspaceLabel="fixture"
      />
    )
  await act(async () => renderSidebar(prRepo, 'clone::/worktree'))
  const sheet = () => container.querySelector('[data-sheet]')
  const press = async (label: string) => {
    const button = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
    if (!button) {
      throw new Error(`missing ${label}`)
    }
    await act(async () => button.click())
  }
  const spinner = () => sheet()?.querySelector('[role="progressbar"]') ?? null
  const text = () => sheet()?.textContent ?? ''
  const typeSearch = (value: string) => act(async () => io.search!.onChangeText!(value))
  // The approvals gate row is the tab's way into the reviewers sheet; the sheet's Done closes it.
  const openSheet = () => press('No approvals yet')
  const closeSheet = () => press('Done')
  // Sends since the last check, at the status and list boundaries.
  const sent = () => frames.splice(0)
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

  // Opening alone does no candidate work; the first search is the demand.
  await openSheet()
  await settle()
  expect(sheet()).not.toBeNull()
  expect(sent()).toEqual([])
  expect(text()).not.toContain('Disconnected')
  await typeSearch('o')
  await settle()
  expect(text()).toContain('Update Orca')
  expect(sent()).toEqual(['status.get'])
  expect(io.gh).not.toHaveBeenCalled()
  await closeSheet()
  expect(sheet()).toBeNull()
  capable = true
  await openSheet()
  await settle()
  expect(sent()).toEqual([])
  expect(text()).not.toContain('Update Orca')
  await typeSearch('o')
  await settle()
  expect(text()).toContain('fork-only')
  expect(text()).not.toContain('upstream-only')
  expect(io.gh.mock.calls[0][0]).toContain('repos/fork/widgets/assignees?per_page=100')
  await press('fork-only')
  expect(io.requestReviewer).toHaveBeenCalledWith('fork-only')
  expect(sent()).toEqual(['status.get', 'github.listAssignableUsers'])
  // Clearing the search shows the requested view and keeps the visit's candidates without another read.
  await typeSearch('')
  await settle()
  expect(text()).toContain('No reviewers requested')
  await typeSearch('o')
  await settle()
  expect(text()).toContain('fork-only')
  expect(sent()).toEqual([])
  await closeSheet()
  let session = physical
  const migrate = async () => {
    session = createFakeRpcClient()
    session.sendRequest = physical.sendRequest
    await act(async () => logical.migrateTo(session, 'lan'))
    await settle()
  }
  const openAndSearch = async () => {
    await openSheet()
    await typeSearch('o')
    await settle()
  }

  // 1. A connected-to-connected migration mid-load starts a successor instead of a false empty list.
  let late!: (value: { stdout: string }) => void
  io.gh.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        late = resolve
      })
  )
  await openAndSearch()
  expect(spinner()).not.toBeNull()
  await migrate()
  expect(text()).not.toContain('No matching people')
  expect(text()).toContain('fork-only')
  await act(async () => late({ stdout: '{"login":"retired-person"}' }))
  await settle()
  expect(text()).not.toContain('retired-person')
  expect(sent()).toEqual([
    'status.get',
    'github.listAssignableUsers',
    'status.get',
    'github.listAssignableUsers'
  ])

  // 2. Loaded rows and the search stay in place through a disconnect and the refresh reconnecting starts.
  hold = true
  await act(async () => session.pushState('disconnected'))
  expect(spinner()).toBeNull()
  expect(text()).toContain('fork-only')
  expect(sent()).toEqual([])
  await act(async () => session.pushState('connected'))
  await settle()
  expect(sent()).toEqual(['status.get', 'github.listAssignableUsers'])
  expect(spinner()).toBeNull()
  expect(text()).toContain('fork-only')
  expect(io.search!.value).toBe('o')
  io.gh.mockImplementationOnce(async () => ({
    stdout: '{"login":"fork-only"}\n{"login":"fork-second"}'
  }))
  await act(async () => held.shift()!.release())
  await settle()
  expect(text()).toContain('fork-second')

  // A loaded migration refreshes silently, and a failed background read keeps accepted rows.
  await migrate()
  expect(sent()).toEqual(['status.get', 'github.listAssignableUsers'])
  expect(spinner()).toBeNull()
  await act(async () => held.shift()!.fail())
  await settle()
  expect(text()).toContain('fork-second')
  expect(text()).not.toContain('socket closed')

  // Reopening is fresh demand; a down-up pair in one render still retires the first attempt.
  await closeSheet()
  await openSheet()
  await settle()
  expect(sent()).toEqual([])
  await typeSearch('o')
  await settle()
  expect(text()).not.toContain('fork-second')
  expect(spinner()).not.toBeNull()
  expect(sent()).toEqual(['status.get', 'github.listAssignableUsers'])
  await act(async () => {
    session.pushState('disconnected')
    session.pushState('connected')
  })
  await settle()
  expect(sent()).toEqual(['status.get', 'github.listAssignableUsers'])
  await act(async () => held.shift()!.fail())
  await settle()
  expect(text()).not.toContain('socket closed')
  expect(spinner()).not.toBeNull()
  await act(async () => held.shift()!.release())
  await settle()
  expect(text()).toContain('fork-only')

  // A first search while reconnecting sends nothing offline, explains the outage, and completes on recovery.
  await closeSheet()
  await act(async () => session.pushState('reconnecting'))
  io.gh.mockClear()
  await openAndSearch()
  expect(text()).not.toContain('fork-only')
  expect(text()).toContain('Reconnecting')
  await act(async () => session.pushState('disconnected'))
  expect(text()).toContain('Disconnected')
  // The header's relay verdict explains the wait rather than the bare dial state.
  relay = { relayHostReachability: 'unreachable' }
  await act(async () => renderSidebar(prRepo, 'clone::/worktree'))
  expect(text()).toContain("Can't reach Relay")
  relay = {}
  await act(async () => renderSidebar(prRepo, 'clone::/worktree'))
  await act(async () => session.pushState('auth-failed'))
  expect(text()).toContain('Pairing invalid — re-pair with your desktop')
  expect(sent()).toEqual([])
  expect(io.gh).not.toHaveBeenCalled()
  await act(async () => session.pushState('connected'))
  await settle()
  // Exactly one recovery read, pending with the search kept and no error published.
  expect(sent()).toEqual(['status.get', 'github.listAssignableUsers'])
  expect(io.search!.value).toBe('o')
  expect(spinner()).not.toBeNull()
  expect(text()).not.toContain('Pairing invalid')
  expect(text()).not.toContain('Failed to load people')
  await act(async () => held.shift()!.release())
  await settle()
  expect(io.gh).toHaveBeenCalledTimes(1)
  expect(text()).toContain('fork-only')
  expect(sent()).toEqual([])

  // A to B to A: a repository departure closes the open request; each target is a new visit, and no earlier visit's
  // reply can paint the current one.
  const upstream = { owner: 'upstream', repo: 'widgets', host: 'github.corp' }
  await closeSheet()
  await openAndSearch()
  await act(async () => renderSidebar(upstream, 'clone::/worktree'))
  await settle()
  expect(sheet()).toBeNull()
  await openAndSearch()
  expect(spinner()).not.toBeNull()
  await act(async () => renderSidebar(prRepo, 'clone::/worktree'))
  await settle()
  // The departed request never comes back on return.
  expect(sheet()).toBeNull()
  await openAndSearch()
  expect(spinner()).not.toBeNull()
  expect(sent()).toEqual([
    'status.get',
    'github.listAssignableUsers',
    'status.get',
    'github.listAssignableUsers',
    'status.get',
    'github.listAssignableUsers'
  ])
  const [firstVisit, upstreamVisit, returnVisit] = held.splice(0)
  io.gh.mockClear()
  io.gh.mockImplementationOnce(async () => ({ stdout: '{"login":"retired-person"}' }))
  await act(async () => firstVisit.release())
  await settle()
  await act(async () => upstreamVisit.release())
  await settle()
  expect(io.gh.mock.calls[1][0]).toContain('repos/upstream/widgets/assignees?per_page=100')
  expect(text()).not.toContain('retired-person')
  expect(text()).not.toContain('upstream-only')
  expect(spinner()).not.toBeNull()
  await act(async () => returnVisit.release())
  await settle()
  expect(text()).toContain('fork-only')

  // A worktree change and a close/reopen while its reply is pending start fresh visits too.
  await act(async () => renderSidebar(prRepo, 'clone::/other'))
  await settle()
  expect(sheet()).toBeNull()
  await openAndSearch()
  expect(spinner()).not.toBeNull()
  await closeSheet()
  await openAndSearch()
  expect(sent()).toEqual([
    'status.get',
    'github.listAssignableUsers',
    'status.get',
    'github.listAssignableUsers'
  ])
  const [worktreeVisit, reopenedVisit] = held.splice(0)
  io.gh.mockImplementationOnce(async () => ({ stdout: '{"login":"retired-person"}' }))
  await act(async () => worktreeVisit.release())
  await settle()
  expect(text()).not.toContain('retired-person')
  expect(spinner()).not.toBeNull()
  await act(async () => reopenedVisit.release())
  await settle()
  expect(text()).toContain('fork-only')

  // A genuine empty reply is the only way to reach the empty state.
  hold = false
  await closeSheet()
  io.gh.mockImplementationOnce(async () => ({ stdout: '' }))
  await openAndSearch()
  expect(text()).toContain('No matching people')
})
