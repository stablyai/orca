// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MobilePRSidebar } from '@orca/test-mobile/components/MobilePRSidebar'
import {
  createFakeRpcClient,
  rpcSuccess
} from '@orca/test-mobile/mobile-web-shell/bridge-host-test-fakes'
import { createStableLogicalRpcClient } from '@orca/test-mobile/transport/stable-logical-rpc-client'
import { RuntimeGitHubRepositoryQueryCommands } from '@orca/test-host/main/runtime/runtime-github-repository-query-commands'
import { GITHUB_REPO_WORK_ITEM_METHODS } from '@orca/test-host/main/runtime/rpc/methods/github-repo-work-item-methods'
import type { OrcaRuntimeService } from '@orca/test-host/main/runtime/orca-runtime'
import { eraseRpcMethods } from '@orca/test-host/main/runtime/rpc/core'
import type { GitHubWorkItemDetails } from '@orca/test-host/shared/github/work-item-types'
import type { Repo } from '@orca/test-host/shared/repo-types'
const io = vi.hoisted(() => ({ gh: vi.fn(), resolved: vi.fn(), requestReviewer: vi.fn() }))
vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
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
vi.mock('lucide-react-native', () => ({
  Search: () => null,
  Check: () => null,
  X: () => null,
  UserPlus: () => null,
  RotateCw: () => null
}))
vi.mock('../../components/BottomDrawer', () => ({
  BottomDrawer: ({
    visible,
    children,
    onClose
  }: React.PropsWithChildren<{ visible: boolean; onClose: () => void }>) =>
    visible ? (
      <div>
        <button aria-label="Close picker" onClick={onClose} />
        {children}
      </div>
    ) : null
}))
vi.mock('../../components/pr-sidebar/mobile-pr-sidebar-styles', () => ({
  mobilePrSidebarStyles: {}
}))
vi.mock('../../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'dark' }))
vi.mock('../../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string, args?: { login: string }) =>
    fallback.replace('{{login}}', args?.login ?? '')
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
    resolveReviewerRequested: (_login: string, value: boolean) => value,
    isBusy: () => false,
    requestReviewer: io.requestReviewer,
    removeReviewer: vi.fn()
  })
}))
vi.mock('../../session/use-mobile-pr-comment-actions', () => ({
  useMobilePrCommentActions: () => ({})
}))
vi.mock('../../session/use-mobile-pr-title-action', () => ({ useMobilePrTitleAction: () => ({}) }))
vi.mock('../../session/use-mobile-pr-ai-triage', () => ({
  useMobilePrAiTriage: () => ({ isBusy: () => false, noticeFor: () => ({}), availability: 'ready' })
}))
vi.mock('../../components/host-protocol-gates-context', () => ({
  useHostProtocolGates: () => ({ hostCapabilities: [], statusPending: false, statusReadable: true })
}))
vi.mock('../../session/use-pr-bot-author-overrides', () => ({
  usePRBotAuthorOverrides: () => new Set()
}))
vi.mock('../../components/pr-sidebar/PRSidebarHeader', () => ({ PRSidebarHeader: () => null }))
vi.mock('../../components/pr-sidebar/PRActionsSection', () => ({ PRActionsSection: () => null }))
vi.mock('../../components/pr-sidebar/PRConflictingFilesSection', () => ({
  PRConflictingFilesSection: () => null
}))
vi.mock('../../components/pr-sidebar/PRChecksSection', () => ({ PRChecksSection: () => null }))
vi.mock('../../components/pr-sidebar/PRCommentsSection', () => ({ PRCommentsSection: () => null }))
vi.mock('../../components/pr-sidebar/PrSidebarCreateEmptyState', () => ({
  PrSidebarCreateEmptyState: () => null
}))
let root: ReturnType<typeof createRoot> | undefined
afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = undefined
  vi.unstubAllGlobals()
})
it('real sidebar/section/drawer sends accepted fork to the runtime provider with original worktree/account, supports refusal/reopen/migration, and keeps one visit rows across connection changes', async () => {
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
  const renderSidebar = (target: typeof prRepo, worktreeId: string) =>
    root!.render(
      <MobilePRSidebar
        client={logical}
        state={{
          kind: 'ready',
          data: {
            pr: {
              number: 93,
              state: 'open',
              title: 'fork',
              url: details.item.url,
              prRepo: target,
              checksStatus: 'success',
              updatedAt: '',
              mergeable: 'MERGEABLE'
            },
            details,
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
  const press = async (label: string) => {
    const button = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
    if (!button) {
      throw new Error(`missing ${label}`)
    }
    await act(async () => button.click())
  }
  await press('Add or remove reviewers')
  expect(container.textContent).toContain('Update Orca')
  expect(frames).toEqual(['status.get'])
  expect(io.gh).not.toHaveBeenCalled()
  await press('Close picker')
  capable = true
  await press('Add or remove reviewers')
  expect(container.textContent).toContain('fork-only')
  expect(container.textContent).not.toContain('upstream-only')
  expect(io.gh.mock.calls[0][0]).toContain('repos/fork/widgets/assignees?per_page=100')
  await press('Request fork-only')
  expect(io.requestReviewer).toHaveBeenCalledWith('fork-only')
  expect(frames).toEqual(['status.get', 'status.get', 'github.listAssignableUsers'])
  await press('Close picker')
  const spinner = () => container.querySelector('[role="progressbar"]')
  const text = () => container.textContent ?? ''
  // Sends since the last check, at the status and list boundaries.
  const sent = () => frames.splice(0)
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  let session = physical
  const migrate = async () => {
    session = createFakeRpcClient()
    session.sendRequest = physical.sendRequest
    await act(async () => logical.migrateTo(session, 'lan'))
    await settle()
  }
  sent()

  // 1. A connected-to-connected migration mid-load starts a successor instead of a false empty list.
  let late!: (value: { stdout: string }) => void
  io.gh.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        late = resolve
      })
  )
  await press('Add or remove reviewers')
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

  // 2. Loaded rows stay in place through a disconnect and the refresh reconnecting starts.
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
  await press('Close picker')
  await press('Add or remove reviewers')
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

  // Opening offline sends nothing; the drawer explains the outage and recovers on connect.
  await press('Close picker')
  await act(async () => session.pushState('disconnected'))
  io.gh.mockClear()
  await press('Add or remove reviewers')
  expect(text()).not.toContain('fork-only')
  expect(text()).toContain('Disconnected')
  await act(async () => session.pushState('auth-failed'))
  expect(text()).toContain('Pairing invalid — re-pair with your desktop')
  expect(sent()).toEqual([])
  expect(io.gh).not.toHaveBeenCalled()
  hold = false
  await act(async () => session.pushState('connected'))
  await settle()
  expect(sent()).toEqual(['status.get', 'github.listAssignableUsers'])
  expect(io.gh).toHaveBeenCalledTimes(1)
  expect(text()).toContain('fork-only')
  expect(text()).not.toContain('Pairing invalid')

  // A to B to A: each target is a new visit, and no earlier visit's reply can paint the current one.
  hold = true
  const upstream = { owner: 'upstream', repo: 'widgets', host: 'github.corp' }
  await migrate()
  await act(async () => renderSidebar(upstream, 'clone::/worktree'))
  await settle()
  expect(text()).not.toContain('fork-only')
  expect(spinner()).not.toBeNull()
  await act(async () => renderSidebar(prRepo, 'clone::/worktree'))
  await settle()
  expect(text()).not.toContain('fork-only')
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
  io.gh.mockImplementationOnce(async () => ({ stdout: '{"login":"retired-person"}' }))
  await act(async () => firstVisit.release())
  await settle()
  await act(async () => upstreamVisit.release())
  await settle()
  expect(text()).not.toContain('retired-person')
  expect(text()).not.toContain('upstream-only')
  expect(spinner()).not.toBeNull()
  await act(async () => returnVisit.release())
  await settle()
  expect(text()).toContain('fork-only')

  // A worktree change and a close/reopen while its reply is pending start fresh visits too.
  await act(async () => renderSidebar(prRepo, 'clone::/other'))
  await settle()
  expect(text()).not.toContain('fork-only')
  expect(spinner()).not.toBeNull()
  await press('Close picker')
  await press('Add or remove reviewers')
  await settle()
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
  await press('Close picker')
  io.gh.mockImplementationOnce(async () => ({ stdout: '' }))
  await press('Add or remove reviewers')
  await settle()
  expect(text()).toContain('No matching people')
})
