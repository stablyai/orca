import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import { openMobileFileTap } from './mobile-file-tap-open'

describe('headless file tap reply', () => {
  it.each(['another-terminal', 'newer-tap'])('does not navigate after %s', async (change) => {
    let finishOpen: (reply: RpcResponse) => void = () => {
      throw new Error('files.open has not started')
    }
    const pendingOpen = new Promise<RpcResponse>((resolve) => {
      finishOpen = resolve
    })
    const client = {
      sendRequest: vi.fn(async (method: string): Promise<RpcResponse> => {
        if (method === 'files.open') {
          return pendingOpen
        }
        return {
          id: 'resolve-1',
          ok: true,
          result: {
            worktree: 'wt-1',
            relativePath: 'notes.md',
            exists: true,
            isDirectory: false
          }
        }
      })
    }
    let changed = false
    const pushPreviewRoute = vi.fn()
    openMobileFileTap({
      client,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      pathText: 'notes.md',
      line: null,
      column: null,
      pushPreviewRoute,
      openBrowser: vi.fn(),
      triggerOpenFeedback: vi.fn(),
      fetchSessionTabs: vi.fn(),
      getSessionTabs: () => [],
      getActiveSessionTabId: () => null,
      getActivationState: (activated) => ({
        activated,
        activationSeq: 1,
        latestActivationSeq: changed && change === 'newer-tap' ? 2 : 1,
        sourceTerminalHandle: 'terminal-1',
        activeTerminalHandle:
          changed && change === 'another-terminal' ? 'terminal-2' : 'terminal-1',
        activeTabType: 'terminal'
      }),
      switchSessionTab: vi.fn(),
      scheduleDelayedAction: vi.fn()
    })
    await vi.waitFor(() =>
      expect(client.sendRequest).toHaveBeenCalledWith(
        'files.open',
        { worktree: 'id:wt-1', relativePath: 'notes.md' },
        { timeoutMs: 15_000 }
      )
    )
    changed = true
    finishOpen({
      id: 'open-1',
      ok: false,
      error: { code: 'runtime_error', message: 'renderer_unavailable' }
    })
    await pendingOpen
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pushPreviewRoute).not.toHaveBeenCalled()
  })
})
