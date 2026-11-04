import { createElement, useCallback, useLayoutEffect, useState } from 'react'
import { useMobileSourceControlRefresh } from '../source-control/use-mobile-source-control-refresh'
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
// The text action's haptics import react-native, which the node test runner can't parse.
vi.mock('../platform/haptics', () => ({ triggerError: () => {}, triggerSuccess: () => {} }))
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

function probeClient(): RpcClient {
  // Connection for these tests is the connState prop. The client still has to accept the sidebar's subscription.
  const client = {
    sendRequest: vi.fn(),
    getState: () => 'disconnected',
    onStateChange: () => () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these tests call only sendRequest, getState, and onStateChange; connection changes come from the connState prop.
  return client as unknown as RpcClient
}

describe('useMobilePrSidebarController repo probe', () => {
  const client = probeClient()
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

  it('picks up a remote added while the workspace stays mounted', async () => {
    fetchGithubRepoSlugMock.mockResolvedValue({ ok: true, result: null })
    await act(async () => {
      renderer = create(
        createElement(Harness, {
          client,
          connState: 'connected',
          worktreeId: 'w',
          branch: 'main',
          headSha: 'sha'
        })
      )
    })
    expect(captured?.prSidebarIsGithubRepo).toBe(false)

    fetchGithubRepoSlugMock.mockResolvedValue({ ok: true, result: { owner: 'o', repo: 'r' } })
    await act(async () => {
      expect(await captured!.refreshPRSidebarRepoProbe()).toBe(true)
    })
    expect(captured?.prSidebarIsGithubRepo).toBe(true)
  })

  it('does not let an older probe overwrite the refreshed provider', async () => {
    const original = Promise.withResolvers<{ ok: true; result: null }>()
    fetchGithubRepoSlugMock.mockReturnValueOnce(original.promise)
    await act(async () => {
      renderer = create(
        createElement(Harness, {
          client,
          connState: 'connected',
          worktreeId: 'w',
          branch: 'main',
          headSha: 'sha'
        })
      )
    })
    fetchGithubRepoSlugMock.mockResolvedValue({ ok: true, result: { owner: 'o', repo: 'r' } })
    await act(async () => {
      await captured!.refreshPRSidebarRepoProbe()
      original.resolve({ ok: true, result: null })
    })
    expect(captured?.prSidebarIsGithubRepo).toBe(true)
  })

  it('refreshes the PR for the branch committed by the fresh status read', async () => {
    const statusRead = Promise.withResolvers<void>()
    let refresh = () => {}
    rpc.fetchHostedReviewForBranch.mockResolvedValue({ ok: true, result: null })
    rpc.fetchPRForBranch.mockReset().mockResolvedValue({ ok: true, result: null })
    fetchGithubRepoSlugMock.mockResolvedValue({ ok: true, result: null })
    function RefreshHarness() {
      const [branch, setBranch] = useState('main')
      const controller = useMobilePrSidebarController({
        client,
        connState: 'connected',
        worktreeId: 'w',
        branch,
        headSha: 'sha'
      })
      captured = controller
      const loadStatus = useCallback(async () => {
        await statusRead.promise
        setBranch('desktop-topic')
        return true
      }, [])
      refresh = useMobileSourceControlRefresh({
        client,
        worktreeId: 'w',
        loadStatus,
        prController: controller,
        includeDetails: true
      })
      return null
    }
    await act(async () => {
      renderer = create(createElement(RefreshHarness))
    })
    fetchGithubRepoSlugMock.mockResolvedValue({ ok: true, result: { owner: 'o', repo: 'r' } })
    await act(async () => refresh())
    expect(rpc.fetchPRForBranch).not.toHaveBeenCalled()
    await act(async () => statusRead.resolve())
    expect(rpc.fetchPRForBranch.mock.calls.map((call) => call[2].branch)).toEqual(['desktop-topic'])
    expect(captured?.prSidebarIsGithubRepo).toBe(true)
    expect(captured?.prSidebarState.kind).toBe('none')
  })

  it.each(['refusal', 'rejection'])(
    'retains the shown review when re-probing fails: %s',
    async (failure) => {
      fetchGithubRepoSlugMock.mockResolvedValue({ ok: true, result: { owner: 'o', repo: 'r' } })
      rpc.fetchHostedReviewForBranch.mockResolvedValue({ ok: true, result: null })
      rpc.fetchPRForBranch.mockResolvedValue({ ok: true, result: null })
      await act(async () => {
        renderer = create(
          createElement(Harness, {
            client,
            connState: 'connected',
            worktreeId: 'w',
            branch: 'main',
            headSha: 'sha'
          })
        )
      })
      await act(async () => {
        await captured!.refetchPRSidebar({ includeDetails: false })
      })
      expect(captured?.prSidebarState.kind).toBe('none')
      if (failure === 'refusal') {
        fetchGithubRepoSlugMock.mockResolvedValue({ ok: false, error: 'Timed out' })
      } else {
        fetchGithubRepoSlugMock.mockRejectedValue(new Error('Disconnected'))
      }
      await act(async () => {
        expect(await captured!.refreshPRSidebarRepoProbe()).toBe(false)
      })
      expect(captured?.prSidebarIsGithubRepo).toBe(true)
      expect(captured?.prSidebarState.kind).toBe('none')
    }
  )

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

  it('selects unknown for each worktree incarnation before layout, ignores late probes and retains same-worktree eligibility', async () => {
    const replies: ((value: {
      ok: true
      result: { owner: string; repo: string } | null
    }) => void)[] = []
    fetchGithubRepoSlugMock.mockImplementation(
      () => new Promise((resolve) => replies.push(resolve))
    )
    const layouts: { worktreeId: string; known: boolean; eligible: boolean }[] = []
    function ObservedHarness(props: Parameters<typeof useMobilePrSidebarController>[0]) {
      const current = useMobilePrSidebarController(props)
      captured = current
      useLayoutEffect(() => {
        layouts.push({
          worktreeId: props.worktreeId,
          known: current.prSidebarRepoProbeLoaded,
          eligible: current.prSidebarIsGithubRepo
        })
      }, [props.worktreeId])
      return null
    }
    const update = async (
      worktreeId: string,
      connState: 'connected' | 'disconnected' = 'connected',
      branch: string | null = null
    ) => {
      await act(async () => {
        const view = createElement(ObservedHarness, {
          client,
          connState,
          worktreeId,
          branch,
          headSha: 'head'
        })
        if (renderer) {
          renderer.update(view)
        } else {
          renderer = create(view)
        }
      })
    }
    await update('a')
    const firstA = replies.shift()!
    await update('b')
    const firstB = replies.shift()!
    expect(captured?.prSidebarRepoProbeLoaded).toBe(false)
    await update('a')
    const secondA = replies.shift()!
    await act(async () => firstA({ ok: true, result: { owner: 'old', repo: 'r' } }))
    expect(captured?.prSidebarRepoProbeLoaded).toBe(false)
    await act(async () => firstB({ ok: true, result: { owner: 'old-b', repo: 'r' } }))
    expect(captured?.prSidebarRepoProbeLoaded).toBe(false)
    await act(async () => secondA({ ok: true, result: { owner: 'current', repo: 'r' } }))
    expect(captured?.prSidebarIsGithubRepo).toBe(true)
    expect(captured?.prSidebarRepoProbeLoaded).toBe(true)
    await update('a', 'disconnected', 'changed-branch')
    expect(captured?.prSidebarIsGithubRepo).toBe(true)
    expect(captured?.prSidebarRepoProbeLoaded).toBe(true)
    expect(fetchGithubRepoSlugMock).toHaveBeenCalledTimes(3)
    await update('a', 'connected', null)
    expect(captured?.prSidebarIsGithubRepo).toBe(true)
    expect(fetchGithubRepoSlugMock).toHaveBeenCalledTimes(4)
    await act(async () => replies.shift()!({ ok: true, result: null }))
    expect(captured?.prSidebarIsGithubRepo).toBe(false)
    expect(captured?.prSidebarRepoProbeLoaded).toBe(true)
    expect(layouts).toEqual([
      { worktreeId: 'a', known: false, eligible: false },
      { worktreeId: 'b', known: false, eligible: false },
      { worktreeId: 'a', known: false, eligible: false }
    ])
  })
})

describe('useMobilePrSidebarController write reconciliation', () => {
  const client = probeClient()
  const pr = (number: number, extra: Partial<PRInfo> = {}): PRInfo => ({
    number,
    title: 'Feat',
    state: 'open',
    url: `https://github.com/acme/widgets/pull/${number}`,
    checksStatus: 'success',
    updatedAt: '2026-11-01T00:00:00Z',
    mergeable: 'MERGEABLE',
    ...extra
  })
  const details = (body: string): GitHubWorkItemDetails => ({
    item: {
      id: 'pr:7',
      type: 'pr',
      number: 7,
      title: 'Feat',
      state: 'open',
      url: 'https://github.com/acme/widgets/pull/7',
      labels: [],
      updatedAt: '2026-11-01T00:00:00Z',
      author: null
    },
    body,
    comments: []
  })
  const CHECK: PRCheckDetail = { name: 'ci', status: 'completed', conclusion: 'success', url: null }
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
    await act(async () => {
      await sidebar!.controller.refetchPRSidebar({ includeDetails: false })
    })
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

  it('lands details that settle in the same batch as a cold first load', async () => {
    await act(async () => {
      renderer = create(createElement(SidebarHarness, { branch: 'topic-a' }))
    })
    await act(async () => {
      await sidebar!.controller.refetchPRSidebar({ includeDetails: true })
    })

    expect(sidebar?.controller.prSidebarState).toMatchObject({
      kind: 'ready',
      data: { pr: { number: 7 }, details: { body: 'Old' } }
    })
  })

  // Phase two settles in the same batch as phase one (a fast read, or a closed client failing at once):
  // the details publication must not restore the PR state the reread just replaced.
  it.each([
    { state: 'closed', details: 'fulfilled' },
    { state: 'closed', details: 'failed' },
    { state: 'merged', details: 'fulfilled' },
    { state: 'merged', details: 'failed' }
  ] as const)(
    'shows the $state PR a reread found when its checks read failed and details $details at once',
    async ({ state, details: detailsOutcome }) => {
      await renderReady('topic-a')
      rpc.fetchPRForBranch.mockResolvedValue({ ok: true, result: pr(7, { state }) })
      rpc.fetchPRChecks.mockResolvedValue({ ok: false, error: 'Checks unavailable' })
      rpc.fetchWorkItemDetails.mockResolvedValue(
        detailsOutcome === 'fulfilled'
          ? { ok: true, result: details('New') }
          : { ok: false, error: 'Client closed' }
      )

      await act(async () => {
        await (state === 'closed'
          ? sidebar!.actions.updateState('closed')
          : sidebar!.actions.merge())
      })

      expect(sidebar?.controller.prSidebarState).toMatchObject({
        kind: 'ready',
        data: { pr: { number: 7, state }, checks: [CHECK], checksError: null }
      })
      const shown = sidebar!.controller.prSidebarState
      expect(shown.kind === 'ready' && sidebar!.actions.resolveState(shown.data.pr.state)).toBe(
        state
      )
      expect(sidebar?.actions.error).toBe(state === 'closed' ? 'Connection lost after close' : null)
    }
  )

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
    // Details count only when they name this repository, so the later switch can prove they were not reused.
    const loaded = details('Old')
    rpc.fetchWorkItemDetails.mockResolvedValue({
      ok: true,
      result: { ...loaded, item: { ...loaded.item, url: 'https://github.com/acme/a/pull/7' } }
    })
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
    await act(async () => {
      await sidebar!.controller.refetchPRSidebar({ includeDetails: false })
    })
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
