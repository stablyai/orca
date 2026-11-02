import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRCheckDetail } from '../../../src/shared/github/check-types'
import type { PRInfo } from '../../../src/shared/github/pull-request-types'
import type { GitHubWorkItemDetails } from '../../../src/shared/github/work-item-types'
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
import { useMobilePrTextAction, type MobilePrTextAction } from './use-mobile-pr-text-action'

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
  const pr = (number: number, extra: Partial<PRInfo> = {}) =>
    ({ number, title: 'Feat', state: 'open', ...extra }) as unknown as PRInfo
  const details = (body: string) =>
    ({ item: { number: 7 }, body, comments: [] }) as unknown as GitHubWorkItemDetails
  const CHECK = { name: 'ci', status: 'completed' } as unknown as PRCheckDetail
  let renderer: ReactTestRenderer | null = null
  let sidebar: {
    controller: MobilePrSidebarController
    actions: ReturnType<typeof useMobilePrActions>
    text: MobilePrTextAction
  } | null = null
  const titleWrite = { current: Promise.withResolvers<GitHubPrMutationOutcome>() }
  const ok = async (): Promise<GitHubPrMutationOutcome> => ({ ok: true })
  const mutations: PrActionMutations = {
    mergePR: ok,
    setPRAutoMerge: ok,
    updatePRState: async () => ({ ok: false, error: 'Connection lost after close' }),
    markReadyForReview: ok,
    markDraft: ok,
    requestReviewers: ok,
    removeReviewers: ok,
    rerunChecks: ok
  }
  const textMutations = { updateTitle: () => titleWrite.current.promise, updateBody: ok }

  // The PR tab's wiring: actions and text edits act on the controller's ready PR and reread through it.
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
      refetch: controller.rereadPRSidebarAfterWrite
    }
    sidebar = {
      controller,
      actions: useMobilePrActions({ ...common, mutations }),
      text: useMobilePrTextAction({ ...common, mutations: textMutations })
    }
    return null
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  // Details load after the ready PR renders, as on a device where the reads take time.
  async function renderReady(branch: string, withDetails = false): Promise<void> {
    await act(async () => {
      renderer = create(createElement(SidebarHarness, { branch }))
    })
    await act(async () => sidebar!.controller.refetchPRSidebar({ includeDetails: false }))
    if (withDetails) {
      await act(async () => sidebar!.controller.ensurePrSidebarDetails())
    }
  }

  beforeEach(() => {
    sidebar = null
    titleWrite.current = Promise.withResolvers<GitHubPrMutationOutcome>()
    rpc.fetchGithubRepoSlug.mockReset().mockResolvedValue({ ok: true, result: null })
    rpc.fetchHostedReviewForBranch.mockReset().mockResolvedValue({ ok: true, result: null })
    rpc.fetchPRChecks.mockReset().mockResolvedValue({ ok: true, result: [CHECK] })
    rpc.fetchWorkItemDetails.mockReset().mockResolvedValue({ ok: true, result: details('Old') })
    rpc.fetchPRForBranch
      .mockReset()
      .mockImplementation(
        async (_client: RpcClient, _worktreeId: string, args: { branch: string }) => ({
          ok: true,
          result: pr(args.branch === 'topic-a' ? 7 : 8)
        })
      )
  })

  afterEach(() => {
    act(() => {
      renderer?.unmount()
    })
    renderer = null
  })

  it('keeps the ready PR and the write error when a failed close is followed by a failed reread', async () => {
    await renderReady('topic-a')
    rpc.fetchPRForBranch.mockResolvedValue({ ok: false, error: 'Read unavailable' })

    act(() => {
      void sidebar!.actions.updateState('closed')
    })
    await settle()

    expect(rpc.fetchPRForBranch).toHaveBeenCalledTimes(2)
    expect(sidebar?.controller.prSidebarState).toMatchObject({
      kind: 'ready',
      data: { pr: { number: 7 } }
    })
    expect(sidebar?.actions.error).toBe('Connection lost after close')
  })

  it('shows a merge the reread found even when its checks read failed', async () => {
    await renderReady('topic-a')
    rpc.fetchPRForBranch.mockResolvedValue({ ok: true, result: pr(7, { state: 'merged' }) })
    rpc.fetchPRChecks.mockResolvedValue({ ok: false, error: 'Checks unavailable' })
    rpc.fetchWorkItemDetails.mockReturnValue(new Promise(() => {}))

    act(() => {
      void sidebar!.actions.merge()
    })
    await settle()

    expect(sidebar?.controller.prSidebarState).toMatchObject({
      kind: 'ready',
      data: { pr: { number: 7, state: 'merged' }, checks: [CHECK], checksError: null }
    })
  })

  it('rereads behind a held foreground read, and a pre-write details read cannot land after it', async () => {
    await renderReady('topic-a', true)
    const preWrite = Promise.withResolvers<{ ok: true; result: GitHubWorkItemDetails }>()
    rpc.fetchWorkItemDetails.mockReturnValueOnce(preWrite.promise)
    // A Recheck still waiting on its details read holds the foreground.
    let recheck!: Promise<unknown>
    act(() => {
      recheck = sidebar!.controller.refetchPRSidebar({ includeDetails: true })
    })
    await settle()

    const reread = Promise.withResolvers<{ ok: false; error: string }>()
    rpc.fetchPRForBranch.mockReturnValueOnce(reread.promise)
    rpc.fetchWorkItemDetails.mockResolvedValue({ ok: true, result: details('New') })
    titleWrite.current.resolve({ ok: true })
    let save!: Promise<boolean>
    act(() => {
      save = sidebar!.text.save('title', 'New title', 'Feat')
    })
    await settle()
    expect(rpc.fetchPRForBranch).toHaveBeenCalledTimes(3)
    // The pre-write details read finishes while the reread is in flight: it was retired, so it cannot land.
    preWrite.resolve({ ok: true, result: details('Stale') })
    await settle()
    expect(sidebar?.controller.prSidebarState).toMatchObject({ data: { details: { body: 'Old' } } })

    // The reread fails, so the shown PR stays and its details are read again after the write.
    reread.resolve({ ok: false, error: 'Read unavailable' })
    await act(async () => {
      expect(await save).toBe(true)
      await recheck
    })
    expect(sidebar?.controller.prSidebarState).toMatchObject({
      kind: 'ready',
      data: { pr: { number: 7 }, details: { body: 'New' } }
    })
    expect(sidebar?.text.error).toBeNull()
  })

  it('does not carry details to the same PR number in another repo', async () => {
    rpc.fetchPRForBranch.mockResolvedValue({
      ok: true,
      result: pr(7, { prRepo: { owner: 'acme', repo: 'a' } })
    })
    await renderReady('topic-a', true)
    expect(sidebar?.controller.prSidebarState).toMatchObject({ data: { details: { body: 'Old' } } })

    rpc.fetchPRForBranch.mockResolvedValue({
      ok: true,
      result: pr(7, { prRepo: { owner: 'acme', repo: 'b' } })
    })
    rpc.fetchWorkItemDetails.mockReturnValue(new Promise(() => {}))
    act(() => {
      void sidebar!.controller.refetchPRSidebar({ includeDetails: true })
    })
    await settle()

    expect(sidebar?.controller.prSidebarState).toMatchObject({
      kind: 'ready',
      data: { pr: { prRepo: { repo: 'b' } }, details: null }
    })
  })

  it('a late failed title write after a branch switch cannot load the previous branch', async () => {
    await renderReady('topic-a')
    const staleReread = sidebar!.controller.rereadPRSidebarAfterWrite
    let save!: Promise<boolean>
    act(() => {
      save = sidebar!.text.save('title', 'New title', 'Feat')
    })
    await act(async () => {
      renderer!.update(createElement(SidebarHarness, { branch: 'topic-b' }))
    })
    await act(async () => sidebar!.controller.refetchPRSidebar({ includeDetails: false }))
    expect(sidebar?.controller.prSidebarState).toMatchObject({ data: { pr: { number: 8 } } })
    rpc.fetchPRForBranch.mockClear()

    titleWrite.current.resolve({ ok: false, error: 'Connection lost' })
    await act(async () => {
      await save
    })
    // An obsolete captured reread cannot claim the current branch either.
    await act(async () => staleReread())
    await settle()

    expect(rpc.fetchPRForBranch).not.toHaveBeenCalled()
    expect(sidebar?.controller.prSidebarState).toMatchObject({
      kind: 'ready',
      data: { pr: { number: 8 } }
    })
    expect(sidebar?.text.error).toBeNull()
  })
})
