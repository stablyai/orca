import { describe, expect, it, vi } from 'vitest'
import { browserSurfaceReceipt } from '../../../shared/maestro-browser-surface.test'
import { createMaestroBrowserSurfaceReconciliationHost } from './maestro-browser-surface-reconciliation'

// The runtime reports the raw worktree id; the Maestro receipt carries the prefixed workspace key.
const WORKTREE_ID = 'repo-1::/repos/orca-wt'
const WORKSPACE_KEY = `worktree:${WORKTREE_ID}`

function reconcilableReceipt() {
  return { ...browserSurfaceReceipt(), workspace_key: WORKSPACE_KEY }
}

describe('maestro browser surface reconciliation host', () => {
  it('observes the exact page by worktree id and reports the observation as a workspace key', async () => {
    const receipt = reconcilableReceipt()
    const browserTabShow = vi.fn().mockResolvedValue({
      tab: {
        browserPageId: receipt.browser_page_id,
        worktreeId: WORKTREE_ID,
        profileId: receipt.profile_id,
        active: true
      }
    })
    const host = createMaestroBrowserSurfaceReconciliationHost({
      browserTabShow,
      browserTabClose: vi.fn()
    })

    const observation = await host.observePage(receipt)

    expect(browserTabShow).toHaveBeenCalledWith({
      page: receipt.browser_page_id,
      worktree: `id:${WORKTREE_ID}`
    })
    // Feeds identityMatches, which compares against receipt.workspace_key.
    expect(observation).toMatchObject({ verdict: 'live', workspaceKey: WORKSPACE_KEY })
  })

  it('closes the exact page by worktree id', async () => {
    const receipt = reconcilableReceipt()
    const browserTabClose = vi.fn().mockResolvedValue(undefined)
    const host = createMaestroBrowserSurfaceReconciliationHost({
      browserTabShow: vi.fn(),
      browserTabClose
    })

    const observation = await host.closePage(receipt)

    expect(browserTabClose).toHaveBeenCalledWith({
      page: receipt.browser_page_id,
      worktree: `id:${WORKTREE_ID}`
    })
    expect(observation).toMatchObject({ verdict: 'exited', workspaceKey: WORKSPACE_KEY })
  })
})
