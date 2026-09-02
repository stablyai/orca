import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'

const fetchGithubRepoSlugMock = vi.fn()

// Only the repo probe matters here; the load path never runs without a branch.
vi.mock('./github-pr-rpc', () => ({
  fetchGithubRepoSlug: (...args: unknown[]) => fetchGithubRepoSlugMock(...args),
  fetchHostedReviewForBranch: vi.fn(),
  fetchPRChecks: vi.fn(),
  fetchPRForBranch: vi.fn(),
  fetchWorkItemDetails: vi.fn()
}))
vi.mock('../source-control/mobile-pr-link', () => ({
  fetchWorktreeLinkedPR: vi.fn(async () => null)
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
  // Two ticks: the probe's resolved promise (.then) plus its setState commit.
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

  // Regression: repo eligibility must not be gated on a branch. A detached HEAD /
  // mid-rebase worktree (branch === null) still has to resolve the probe, or the
  // Pull Request segment gets stranded on a forever spinner instead of the
  // "Current branch unavailable" state.
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
    // No branch means no PR load ran — state stays hidden, never a spinner.
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
