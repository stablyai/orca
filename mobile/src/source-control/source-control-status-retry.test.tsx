import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { createFakeRpcClient, rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'

const doubles = vi.hoisted(
  (): {
    forceReconnect: ((hostId: string) => Promise<void>) | null
    client: RpcClient | null
    ignoreError: () => void
  } => ({ forceReconnect: null, client: null, ignoreError: () => {} })
)

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('./MobileSourceControlHeader', () => ({ MobileSourceControlHeader: () => null }))
vi.mock('./MobileSourceControlContent', () => ({ MobileSourceControlContent: () => null }))
vi.mock('./MobileSourceControlModals', () => ({ MobileSourceControlModals: () => null }))
vi.mock('./MobileSourceControlSegments', () => ({ MobileSourceControlSegments: () => null }))
vi.mock('./MobileSourceControlBranchCard', () => ({ MobileSourceControlBranchCard: () => null }))
vi.mock('./MobileGitHistoryList', () => ({ MobileGitHistoryList: () => null }))
vi.mock('../components/pr-sidebar/MobilePrViewPanel', () => ({ MobilePrViewPanelBody: () => null }))
vi.mock('../components/mobile-pr-url', () => ({ openMobilePrUrl: () => {} }))
vi.mock('./use-mobile-source-control-action-sheet', () => ({
  useMobileSourceControlActionSheet: () => ({})
}))
// The page has no forceReconnect; native providers supply it to redial after failed reads.
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return { useFocusEffect: useEffect }
})
vi.mock('./use-mobile-source-control-state', async () => {
  const { useMobileSourceControlLoaders } = await import('./use-mobile-source-control-loaders')
  return {
    useMobileSourceControlState: ({
      hostId,
      worktreeId
    }: {
      hostId: string
      worktreeId: string
    }) => {
      const connState = doubles.client ? 'connected' : 'reconnecting'
      const loaders = useMobileSourceControlLoaders({
        client: doubles.client,
        connState,
        worktreeId,
        statusIdentityKey: `${hostId}\0${worktreeId}`,
        setActionError: doubles.ignoreError
      })
      const status = loaders.screenState.kind === 'ready' ? loaders.screenState.status : null
      return {
        client: doubles.client,
        connState,
        forceReconnect: doubles.forceReconnect,
        insets: { top: 0, bottom: 0, left: 0, right: 0 },
        router: { back: () => {} },
        setRootRef: () => {},
        worktreeLabel: 'wt',
        screenState: loaders.screenState,
        busyAction: null,
        openingPath: null,
        openingBranchPath: null,
        loadStatus: loaders.loadStatus,
        status,
        branchCompareResult: null,
        branchLabel: '',
        syncLabel: '',
        unstagedCount: 0,
        stagedCount: 0,
        branchEntries: [],
        abortConflictOperation: () => Promise.resolve(),
        resolveConflict: () => Promise.resolve(),
        completeMerge: () => Promise.resolve(),
        primaryActionArgs: {
          status: null,
          hasUnresolvedConflicts: false,
          stageablePaths: [],
          stagedCount: 0,
          unstagedCount: 0,
          commitMessage: '',
          busyAction: null,
          openingPath: null,
          openingBranchPath: null,
          branchCompareResult: null,
          handlers: {}
        }
      }
    }
  }
})

import { MobileSourceControlPanel } from './MobileSourceControlPanel'

let tree: ReactTestRenderer | null = null

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  doubles.client = null
})

function render(): ReactTestRenderer {
  act(() => {
    tree = create(createElement(MobileSourceControlPanel, { hostId: 'host-a', worktreeId: 'wt-1' }))
  })
  if (tree === null) {
    throw new Error('the panel did not render')
  }
  return tree
}

function retryControls(rendered: ReactTestRenderer): ReactTestInstance[] {
  return rendered.root
    .findAll((node) => String(node.type) === 'Pressable')
    .filter((node) =>
      node
        .findAll((text) => String(text.type) === 'Text')
        .some((text) => text.props.children === 'Retry')
    )
}

describe("source control's status Retry while the host is unreachable", () => {
  it('is absent on the page, where nothing can re-dial', () => {
    doubles.forceReconnect = null
    const rendered = render()
    expect(
      rendered.root.findAll((node) => node.props.children === 'Waiting for desktop...')
    ).not.toHaveLength(0)
    expect(retryControls(rendered)).toHaveLength(0)
  })

  it('offers Retry when a reconnect callback is available and dispatches this host', () => {
    const forceReconnect = vi.fn(() => Promise.resolve())
    doubles.forceReconnect = forceReconnect
    const [retry] = retryControls(render())
    act(() => {
      retry?.props.onPress()
    })
    expect(forceReconnect.mock.calls).toEqual([['host-a']])
  })
})

it('reuses Source Control across worktrees without loading the old fallback into the new worktree, then continues chip and PR demand', async () => {
  const client = createFakeRpcClient()
  doubles.client = client
  const requests: { method: string; params: unknown }[] = []
  const pendingProbes: ((reply: RpcResponse) => void)[] = []
  const pendingStatuses: ((reply: RpcResponse) => void)[] = []
  let switched = false
  const repository = { owner: 'fork', repo: 'widgets', host: 'github.corp' }
  const pullRequest = {
    number: 93,
    state: 'open',
    title: 'PR',
    url: 'https://github.corp/fork/widgets/pull/93',
    prRepo: repository,
    headSha: 'pr-head'
  }
  const status = (branch: string) => ({ entries: [], branch, head: `${branch}-head` })
  client.sendRequest = async (method, params) => {
    requests.push({ method, params })
    if (switched && method === 'github.repoSlug') {
      return new Promise((resolve) => pendingProbes.push(resolve))
    }
    if (switched && method === 'git.status') {
      return new Promise((resolve) => pendingStatuses.push(resolve))
    }
    const value =
      method === 'github.repoSlug'
        ? repository
        : method === 'git.status'
          ? status('old-branch')
          : method === 'repo.list'
            ? { repos: [] }
            : method === 'repo.baseRefDefault'
              ? { defaultBaseRef: null }
              : method === 'settings.get'
                ? { settings: {} }
                : method === 'worktree.show'
                  ? { worktree: { branch: switched ? 'new-branch' : 'old-branch' } }
                  : method === 'hostedReview.forBranch'
                    ? null
                    : method === 'github.prForBranch'
                      ? pullRequest
                      : method === 'github.prChecks'
                        ? []
                        : method === 'status.get'
                          ? {
                              runtimeId: 'a',
                              hostDescriptor: { installationId: 'a' },
                              capabilities: ['github.exact-work-item-target.v1']
                            }
                          : method === 'github.workItemDetails'
                            ? {
                                item: {
                                  ...pullRequest,
                                  id: 'PR_93',
                                  type: 'pr',
                                  labels: [],
                                  updatedAt: '',
                                  author: null
                                },
                                body: 'body',
                                comments: []
                              }
                            : undefined
    if (value === undefined) {
      throw new Error(`unexpected ${method}`)
    }
    return rpcSuccess(method, value)
  }
  await act(async () => {
    tree = create(createElement(MobileSourceControlPanel, { hostId: 'host-a', worktreeId: 'wt-1' }))
  })
  expect(requests.filter((r) => r.method === 'github.prForBranch')).toHaveLength(1)
  expect(requests.filter((r) => r.method === 'github.workItemDetails')).toHaveLength(0)
  const beforeSwitch = requests.length
  switched = true
  await act(async () =>
    tree!.update(createElement(MobileSourceControlPanel, { hostId: 'host-a', worktreeId: 'wt-2' }))
  )
  const readMethods = new Set([
    'worktree.show',
    'hostedReview.forBranch',
    'github.prForBranch',
    'github.prChecks',
    'github.workItemDetails'
  ])
  expect(requests.slice(beforeSwitch).filter((r) => readMethods.has(r.method))).toEqual([])
  expect(pendingProbes).toHaveLength(1)
  expect(pendingStatuses).toHaveLength(1)
  await act(async () => pendingProbes.shift()!(rpcSuccess('probe-w2', repository)))
  expect(requests.slice(beforeSwitch).filter((r) => readMethods.has(r.method))).toEqual([])
  await act(async () => pendingStatuses.shift()!(rpcSuccess('status-w2', status('new-branch'))))
  const prReads = requests.filter((r) => r.method === 'github.prForBranch')
  expect(prReads).toHaveLength(2)
  expect(prReads[1].params).toMatchObject({
    repo: 'id:wt-2',
    branch: 'new-branch',
    currentHeadOid: 'new-branch-head'
  })
  const afterSwitch = requests
    .slice(beforeSwitch)
    .filter((r) => r.method === 'hostedReview.forBranch')
  expect(afterSwitch).toHaveLength(1)
  expect(afterSwitch[0].params).toMatchObject({ repo: 'id:wt-2', branch: 'new-branch' })
  expect(requests.filter((r) => r.method === 'github.workItemDetails')).toHaveLength(0)
  await act(async () =>
    tree!.update(
      createElement(MobileSourceControlPanel, {
        hostId: 'host-a',
        worktreeId: 'wt-2',
        initialTab: 'pr'
      })
    )
  )
  expect(requests.filter((r) => r.method === 'github.workItemDetails')).toHaveLength(1)
})
