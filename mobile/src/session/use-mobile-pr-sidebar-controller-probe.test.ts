import { createElement, useLayoutEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'

const fetchGithubRepoSlugMock = vi.fn()

vi.mock('./github-pr-rpc', () => ({
  fetchGithubRepoSlug: (...args: unknown[]) => fetchGithubRepoSlugMock(...args),
  fetchHostedReviewForBranch: vi.fn(),
  fetchPRChecks: vi.fn(),
  fetchPRForBranch: vi.fn(),
  fetchWorkItemDetails: vi.fn()
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
  const client = {
    sendRequest: vi.fn(),
    getState: () => 'connected',
    onStateChange: () => () => {}
  } as unknown as RpcClient
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
