import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRInfo } from '../../../src/shared/github/pull-request-types'
import type { RpcClient } from '../transport/rpc-client'
import type * as GitHubPrRpc from './github-pr-rpc'
import type { GitHubPrMutationOutcome } from './github-pr-mutations'
import type { PrActionMutations } from './pr-action-mutation-contract'

const rpc = vi.hoisted(() => ({
  fetchGithubRepoSlug: vi.fn(),
  fetchHostedReviewForBranch: vi.fn(),
  fetchPRChecks: vi.fn(),
  fetchPRForBranch: vi.fn(),
  fetchWorkItemDetails: vi.fn()
}))
const fetchGithubRepoSlugMock = rpc.fetchGithubRepoSlug

vi.mock('./github-pr-rpc', async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubPrRpc>()),
  ...rpc
}))
vi.mock('../source-control/mobile-pr-link', () => ({
  fetchWorktreeGitHubPRLink: vi.fn(async () => ({
    linkedPR: null,
    suppressedGitHubPR: null,
    pushTarget: null
  })),
  clearMobileWorktreeReviewLink: vi.fn()
}))

import {
  useMobilePrSidebarController,
  type MobilePrSidebarController
} from './use-mobile-pr-sidebar-controller'
import { useMobilePrActions } from './use-mobile-pr-actions'
import { useMobilePrTitleAction, type MobilePrTitleAction } from './use-mobile-pr-title-action'

let captured: MobilePrSidebarController | null = null

function Harness(props: Parameters<typeof useMobilePrSidebarController>[0]) {
  captured = useMobilePrSidebarController(props)
  return null
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useMobilePrSidebarController repo probe', () => {
  const client = { sendRequest: vi.fn() } as unknown as RpcClient
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    captured = null
    fetchGithubRepoSlugMock.mockReset()
  })

  afterEach(() => {
    act(() => {
      renderer?.unmount()
    })
    renderer = null
  })

  // Probe repo eligibility even without a branch so detached/rebasing worktrees reach unavailable state instead of spinning forever.
  it('resolves the probe when connected without a branch (detached HEAD)', async () => {
    fetchGithubRepoSlugMock.mockResolvedValue({ ok: true, result: { owner: 'o', repo: 'r' } })
    await act(async () => {
      renderer = create(
        createElement(Harness, {
          client,
          connState: 'connected',
          worktreeId: 'w',
          branch: null,
          headSha: 'sha'
        })
      )
    })
    await flush()

    expect(fetchGithubRepoSlugMock).toHaveBeenCalledWith(client, 'w')
    expect(captured?.prSidebarRepoProbeLoaded).toBe(true)
    expect(captured?.prSidebarIsGithubRepo).toBe(true)
    expect(captured?.prSidebarState.kind).toBe('hidden')
  })

  it('does not probe until the client is connected', async () => {
    fetchGithubRepoSlugMock.mockResolvedValue({ ok: true, result: { owner: 'o', repo: 'r' } })
    await act(async () => {
      renderer = create(
        createElement(Harness, {
          client,
          connState: 'connecting',
          worktreeId: 'w',
          branch: null,
          headSha: 'sha'
        })
      )
    })
    await flush()

    expect(fetchGithubRepoSlugMock).not.toHaveBeenCalled()
    expect(captured?.prSidebarRepoProbeLoaded).toBe(false)
  })
})

describe('useMobilePrSidebarController write reconciliation', () => {
  const client = { sendRequest: vi.fn() } as unknown as RpcClient
  const pr = (number: number) => ({ number, title: 'Feat', state: 'open' }) as unknown as PRInfo
  let renderer: ReactTestRenderer | null = null
  let sidebar: {
    controller: MobilePrSidebarController
    actions: ReturnType<typeof useMobilePrActions>
    title: MobilePrTitleAction
  } | null = null
  const titleWrite = { current: Promise.withResolvers<GitHubPrMutationOutcome>() }
  const ok = async (): Promise<GitHubPrMutationOutcome> => ({ ok: true })
  const mutations: PrActionMutations = {
    mergePR: ok,
    setPRAutoMerge: ok,
    updatePRState: async () => ({ ok: false, error: 'Connection lost after close' }),
    markReadyForReview: ok,
    requestReviewers: ok,
    removeReviewers: ok,
    rerunChecks: ok
  }
  const titleMutations = { updateTitle: () => titleWrite.current.promise }

  // The sidebar's wiring: actions and title act on the controller's ready PR and reread through it.
  function SidebarHarness({ branch }: { branch: string }) {
    const controller = useMobilePrSidebarController({
      client,
      connState: 'connected',
      worktreeId: 'w',
      branch,
      headSha: 'sha'
    })
    const ready = controller.prSidebarState.kind === 'ready' ? controller.prSidebarState.data : null
    const common = {
      client,
      connState: 'connected' as const,
      worktreeId: 'w',
      prNumber: ready?.pr.number ?? 0,
      prRepo: ready?.pr.prRepo ?? null,
      refetch: controller.refetchPRSidebar
    }
    sidebar = {
      controller,
      actions: useMobilePrActions({ ...common, mutations }),
      title: useMobilePrTitleAction({ ...common, mutations: titleMutations })
    }
    return null
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  async function renderReady(branch: string): Promise<void> {
    await act(async () => {
      renderer = create(createElement(SidebarHarness, { branch }))
    })
    await act(async () => sidebar!.controller.refetchPRSidebar({ includeDetails: false }))
  }

  beforeEach(() => {
    sidebar = null
    titleWrite.current = Promise.withResolvers<GitHubPrMutationOutcome>()
    rpc.fetchGithubRepoSlug.mockReset().mockResolvedValue({ ok: true, result: null })
    rpc.fetchHostedReviewForBranch.mockReset().mockResolvedValue({ ok: true, result: null })
    rpc.fetchPRChecks.mockReset().mockResolvedValue({ ok: true, result: [] })
    rpc.fetchWorkItemDetails.mockReset().mockResolvedValue({ ok: true, result: null })
    rpc.fetchPRForBranch
      .mockReset()
      .mockImplementation(async (_worktreeId: string, args: { branch: string }) => ({
        ok: true,
        result: pr(args.branch === 'topic-a' ? 7 : 8)
      }))
  })

  afterEach(() => {
    act(() => {
      renderer?.unmount()
    })
    renderer = null
  })

  it('keeps the ready PR and the write error when a failed close is followed by a failed reread', async () => {
    await renderReady('topic-a')
    expect(sidebar?.controller.prSidebarState).toMatchObject({
      kind: 'ready',
      data: { pr: { number: 7 } }
    })
    rpc.fetchPRForBranch.mockResolvedValue({ ok: false, error: 'Read unavailable' })

    act(() => sidebar!.actions.updateState('closed'))
    await settle()

    expect(rpc.fetchPRForBranch).toHaveBeenCalledTimes(2)
    expect(sidebar?.controller.prSidebarState).toMatchObject({
      kind: 'ready',
      data: { pr: { number: 7 } }
    })
    expect(sidebar?.actions.error).toBe('Connection lost after close')
  })

  it('a late failed title write after a branch switch cannot load the previous branch', async () => {
    await renderReady('topic-a')
    const staleLoad = sidebar!.controller.refetchPRSidebar
    let save!: Promise<boolean>
    act(() => {
      save = sidebar!.title.setTitle('New title', 'Feat')
    })
    await act(async () => {
      renderer!.update(createElement(SidebarHarness, { branch: 'topic-b' }))
    })
    await act(async () => sidebar!.controller.refetchPRSidebar({ includeDetails: false }))
    expect(sidebar?.controller.prSidebarState).toMatchObject({
      kind: 'ready',
      data: { pr: { number: 8 } }
    })
    rpc.fetchPRForBranch.mockClear()

    titleWrite.current.resolve({ ok: false, error: 'Connection lost' })
    await act(async () => {
      await save
    })
    // An obsolete captured loader cannot claim the current branch either.
    await act(async () => staleLoad({ includeDetails: false }))
    await settle()

    expect(rpc.fetchPRForBranch).not.toHaveBeenCalled()
    expect(sidebar?.controller.prSidebarState).toMatchObject({
      kind: 'ready',
      data: { pr: { number: 8 } }
    })
    expect(sidebar?.title.error).toBeNull()
  })
})
