// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MobilePRSidebar } from '../../components/MobilePRSidebar'
import { createFakeRpcClient, rpcSuccess } from '../../mobile-web-shell/bridge-host-test-fakes'
import { createStableLogicalRpcClient } from '../../transport/stable-logical-rpc-client'
import { RuntimeGitHubRepositoryQueryCommands } from '../../../../src/main/runtime/runtime-github-repository-query-commands'
import { GITHUB_REPO_WORK_ITEM_METHODS } from '../../../../src/main/runtime/rpc/methods/github-repo-work-item-methods'
import type { OrcaRuntimeService } from '../../../../src/main/runtime/orca-runtime'
import { eraseRpcMethods } from '../../../../src/main/runtime/rpc/core'
import type { GitHubWorkItemDetails } from '../../../../src/shared/github/work-item-types'
import type { Repo } from '../../../../src/shared/repo-types'
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
  async () => import('../../../../src/main/github/issue-field-options')
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
it('real sidebar/section/drawer sends accepted fork to the runtime provider with original worktree/account and supports refusal/reopen/migration', async () => {
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
    const result = await method.handler(method.params!.parse(params), { runtime })
    return rpcSuccess('users', result)
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
  await act(async () =>
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
              prRepo,
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
        worktreeId="clone::/worktree"
        gitBranch="feature"
        gitStatus={null}
        headSha={null}
        workspaceLabel="fixture"
      />
    )
  )
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
  let late!: (value: { stdout: string }) => void
  io.gh.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        late = resolve
      })
  )
  await press('Add or remove reviewers')
  expect(container.querySelector('[role="progressbar"]')).not.toBeNull()
  const next = createFakeRpcClient()
  next.sendRequest = physical.sendRequest
  await act(async () => logical.migrateTo(next, 'lan'))
  expect(container.querySelector('[role="progressbar"]')).toBeNull()
  await act(async () => late({ stdout: '{"login":"retired-person"}' }))
  expect(container.textContent).not.toContain('retired-person')
  await press('Close picker')
  await press('Add or remove reviewers')
  expect(container.textContent).toContain('fork-only')
})
