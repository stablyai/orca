import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../../../transport/types'
import type { UnvalidatedRpcRequestPort } from '../../../transport/unvalidated-rpc-request-port'
import { openMobileNativeChatFileTap } from './mobile-native-chat-open-file'

function ok(result: unknown): RpcResponse {
  return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

// Drains the resolve round trip without counting its internal awaits.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function activationState(activated: boolean) {
  return {
    activated,
    activationSeq: 1,
    latestActivationSeq: 1,
    sourceTerminalHandle: 'terminal-1',
    activeTerminalHandle: 'terminal-1',
    activeTabType: 'terminal'
  }
}

function baseOptions(client: UnvalidatedRpcRequestPort) {
  return {
    client,
    hostId: 'host-1',
    worktreeId: 'wt-1',
    pushPreviewRoute: vi.fn(),
    openBrowser: vi.fn(),
    triggerOpenFeedback: vi.fn(),
    fetchSessionTabs: vi.fn(),
    getSessionTabs: () => [],
    getActiveSessionTabId: () => null,
    getActivationState: activationState,
    switchSessionTab: vi.fn(),
    scheduleDelayedAction: vi.fn(),
    onOpenFailed: vi.fn()
  }
}

function worktreeFileResolution(relativePath: string) {
  return ok({
    worktree: 'wt-1',
    relativePath,
    absolutePath: `/repo/${relativePath}`,
    exists: true,
    isDirectory: false,
    openTarget: {
      kind: 'worktree-file',
      provider: 'local',
      relativePath,
      absolutePath: `/repo/${relativePath}`
    }
  })
}

describe('openMobileNativeChatFileTap', () => {
  it('resolves against the worktree root: no terminal handle and no cwd', async () => {
    const sendRequest = vi.fn(async () => worktreeFileResolution('src/app.ts'))
    const options = baseOptions({ sendRequest })

    openMobileNativeChatFileTap({ ...options, pathText: 'src/app.ts' })
    await settle()

    expect(sendRequest).toHaveBeenCalledWith(
      'files.resolveTerminalPath',
      { worktree: 'id:wt-1', pathText: 'src/app.ts', crossWorkspace: true },
      { timeoutMs: 10_000 }
    )
  })

  it('carries the native-chat session identity into resolution and grant refresh', async () => {
    const sendRequest = vi.fn(async () =>
      ok({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: '/Users/ada/orca-plans/result.html',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'absolute-file',
          provider: 'local',
          absolutePath: '/Users/ada/orca-plans/result.html',
          grantId: 'grant-1',
          readOnly: true
        }
      })
    )
    const options = baseOptions({ sendRequest })

    openMobileNativeChatFileTap({
      ...options,
      pathText: '~/orca-plans/result.html',
      nativeChatContext: { tabId: 'tab-1', sessionId: 'session-1' }
    })
    await settle()

    expect(sendRequest).toHaveBeenCalledWith(
      'files.resolveTerminalPath',
      {
        worktree: 'id:wt-1',
        pathText: '~/orca-plans/result.html',
        crossWorkspace: true,
        nativeChatContext: { tabId: 'tab-1', sessionId: 'session-1' }
      },
      { timeoutMs: 10_000 }
    )
    expect(options.pushPreviewRoute).toHaveBeenCalledWith({
      pathname: '/h/[hostId]/files/preview/[worktreeId]',
      params: expect.objectContaining({
        source: 'terminalArtifact',
        absolutePath: '/Users/ada/orca-plans/result.html',
        grantId: 'grant-1',
        nativeChatTab: 'tab-1',
        nativeChatSession: 'session-1'
      })
    })
  })

  it('parses a :line:col citation and opens the mobile preview route', async () => {
    const sendRequest = vi.fn(async () => worktreeFileResolution('src/app.ts'))
    const options = baseOptions({ sendRequest })

    openMobileNativeChatFileTap({ ...options, pathText: 'src/app.ts:120:7' })
    await settle()

    expect(sendRequest).toHaveBeenCalledWith(
      'files.resolveTerminalPath',
      { worktree: 'id:wt-1', pathText: 'src/app.ts', crossWorkspace: true },
      { timeoutMs: 10_000 }
    )
    expect(options.triggerOpenFeedback).toHaveBeenCalledTimes(1)
    expect(options.pushPreviewRoute).toHaveBeenCalledWith({
      pathname: '/h/[hostId]/files/preview/[worktreeId]',
      params: expect.objectContaining({
        source: 'worktree',
        relativePath: 'src/app.ts',
        line: '120',
        column: '7'
      })
    })
    expect(options.onOpenFailed).not.toHaveBeenCalled()
  })

  it('surfaces a resolve miss instead of a silent no-op', async () => {
    const sendRequest = vi.fn(async () =>
      ok({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: null,
        exists: false,
        isDirectory: false
      })
    )
    const options = baseOptions({ sendRequest })

    openMobileNativeChatFileTap({ ...options, pathText: 'gone/missing.ts' })
    await settle()

    expect(options.onOpenFailed).toHaveBeenCalledTimes(1)
    expect(options.pushPreviewRoute).not.toHaveBeenCalled()
    expect(options.triggerOpenFeedback).not.toHaveBeenCalled()
  })

  it('surfaces a rejected resolve request', async () => {
    const sendRequest = vi.fn(async () => {
      throw new Error('Request timed out')
    })
    const options = baseOptions({ sendRequest })

    openMobileNativeChatFileTap({ ...options, pathText: 'src/app.ts' })
    await settle()

    expect(options.onOpenFailed).toHaveBeenCalledTimes(1)
  })

  it('opens a plain path through files.open with tab activation', async () => {
    const responses = [worktreeFileResolution('src/app.ts'), ok({ opened: true })]
    const sendRequest = vi.fn(async (method: string) => {
      const response = responses.shift()
      if (!response) {
        throw new Error(`no scripted response for ${method}`)
      }
      return response
    })
    const openedTab = { id: 'tab-2', relativePath: 'src/app.ts' }
    const switchSessionTab = vi.fn()
    const options = {
      ...baseOptions({ sendRequest }),
      getSessionTabs: () => [openedTab],
      getActiveSessionTabId: () => 'terminal-tab',
      switchSessionTab,
      scheduleDelayedAction: vi.fn((callback: () => void) => callback())
    }

    vi.useFakeTimers()
    try {
      openMobileNativeChatFileTap({ ...options, pathText: 'src/app.ts' })
      await vi.runAllTimersAsync()

      expect(sendRequest).toHaveBeenCalledWith(
        'files.open',
        { worktree: 'id:wt-1', relativePath: 'src/app.ts' },
        { timeoutMs: 15_000 }
      )
      expect(switchSessionTab).toHaveBeenCalledWith(openedTab)
      expect(options.onOpenFailed).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
