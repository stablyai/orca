import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { openMobileFileTap } from './mobile-file-tap-open'
import { nativeHostSessionTerminalFileOperations } from './native-host-session-terminal-file-operations'

describe('native terminal file open result', () => {
  it.each([false, true])('honors the host opened=%s result before polling tabs', async (opened) => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method) => {
      if (method === 'files.resolveTerminalPath') {
        return { ok: true, result: { exists: true, isDirectory: false, relativePath: 'app.zip' } }
      }
      return { ok: true, result: { opened } }
    })
    const onOpenFailed = vi.fn()
    const scheduleDelayedAction = vi.fn()
    openMobileFileTap({
      operations: nativeHostSessionTerminalFileOperations({ sendRequest } as unknown as RpcClient),
      hostId: 'host',
      worktreeId: 'workspace',
      pathText: 'app.zip',
      terminalHandle: 'terminal',
      line: null,
      column: null,
      pushPreviewRoute: vi.fn(),
      openBrowser: vi.fn(),
      triggerOpenFeedback: vi.fn(),
      fetchSessionTabs: vi.fn(),
      getSessionTabs: () => [],
      getActiveSessionTabId: () => 'terminal',
      getActivationState: (activated) => ({
        activated,
        activationSeq: 1,
        latestActivationSeq: 1,
        sourceTerminalHandle: 'terminal',
        activeTerminalHandle: 'terminal',
        activeTabType: 'terminal'
      }),
      switchSessionTab: vi.fn(),
      scheduleDelayedAction,
      onOpenFailed
    })
    await vi.waitFor(() => {
      expect(
        onOpenFailed.mock.calls.length + scheduleDelayedAction.mock.calls.length
      ).toBeGreaterThan(0)
    })
    expect(onOpenFailed).toHaveBeenCalledTimes(opened ? 0 : 1)
    expect(scheduleDelayedAction).toHaveBeenCalledTimes(opened ? 3 : 0)
  })
})
