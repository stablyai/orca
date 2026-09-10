import { describe, expect, it, vi } from 'vitest'
import type { MaestroBrowserSurfaceReceipt } from '../../shared/maestro-browser-surface'
import { browserSurfaceReceipt } from '../../shared/maestro-browser-surface.test'
import { OrcaRuntimeService } from './orca-runtime'

// The bridge reports the raw worktree id; the receipt is anchored by the prefixed workspace key.
const WORKTREE_ID = 'repo-1::/repos/orca-wt'
const WORKSPACE_KEY = `worktree:${WORKTREE_ID}`
const WORKTREE_SELECTOR = `id:${WORKTREE_ID}`

// Why: mirrors OrcaRuntime.resolveWorktreeSelector — an `id:` selector names a worktree id and
// nothing else resolves. A stub that answered any selector would hide a malformed one.
function requireWorktreeSelector(selector: string): void {
  if (selector !== WORKTREE_SELECTOR) {
    throw new Error('selector_not_found')
  }
}

function surfaceReceipt(
  overrides: Partial<MaestroBrowserSurfaceReceipt> = {}
): MaestroBrowserSurfaceReceipt {
  return { ...browserSurfaceReceipt(), workspace_key: WORKSPACE_KEY, ...overrides }
}

function reconcilingRuntime(receipt: MaestroBrowserSurfaceReceipt) {
  const runtime = new OrcaRuntimeService({} as never)
  const scoped = runtime as unknown as {
    _orchestrationDb: unknown
    browserSurfaceReconciliation: Promise<void> | null
    browserTabShow: unknown
    browserTabClose: unknown
  }
  const reconciled: MaestroBrowserSurfaceReceipt[] = []
  scoped._orchestrationDb = {
    listReconcilableMaestroBrowserSurfaces: () => [{ receipt }],
    updateMaestroBrowserSurface: (
      _surfaceId: string,
      update: (current: MaestroBrowserSurfaceReceipt) => MaestroBrowserSurfaceReceipt
    ) => {
      const next = update(receipt)
      reconciled.push(next)
      return { receipt: next }
    }
  }
  const browserTabShow = vi.fn(async ({ worktree }: { page: string; worktree: string }) => {
    requireWorktreeSelector(worktree)
    return {
      tab: {
        browserPageId: receipt.browser_page_id,
        worktreeId: WORKTREE_ID,
        profileId: receipt.profile_id,
        active: true
      }
    }
  })
  const browserTabClose = vi.fn(async ({ worktree }: { page: string; worktree: string }) => {
    requireWorktreeSelector(worktree)
    return {}
  })
  scoped.browserTabShow = browserTabShow
  scoped.browserTabClose = browserTabClose
  return {
    browserTabClose,
    browserTabShow,
    reconciled,
    settled: async () => {
      runtime.setAgentBrowserBridge({} as never)
      await scoped.browserSurfaceReconciliation
      return reconciled.at(-1)
    }
  }
}

describe('runtime browser surface reconciliation', () => {
  it('observes a live surface through a worktree-id selector', async () => {
    const receipt = surfaceReceipt({ state: 'active' })
    const host = reconcilingRuntime(receipt)

    const settled = await host.settled()

    expect(host.browserTabShow).toHaveBeenCalledWith({
      page: receipt.browser_page_id,
      worktree: WORKTREE_SELECTOR
    })
    // A malformed selector resolves to nothing, which downgrades the surface to unverifiable
    // instead of reconciling it live; a raw worktree id in workspaceKey fails the lease identity.
    expect(settled).toMatchObject({
      state: 'active',
      observed_visibility: 'visible',
      focus_receipt: { unavailable_reason: null }
    })
  })

  it('closes a release-pending surface through a worktree-id selector', async () => {
    const receipt = surfaceReceipt({
      state: 'release_pending',
      release_receipt: { ...browserSurfaceReceipt().release_receipt, requested: true }
    })
    const host = reconcilingRuntime(receipt)

    const settled = await host.settled()

    expect(host.browserTabClose).toHaveBeenCalledWith({
      page: receipt.browser_page_id,
      worktree: WORKTREE_SELECTOR
    })
    expect(settled).toMatchObject({
      state: 'released',
      release_receipt: { outcome: 'released', exact_page_closed: true }
    })
  })
})
