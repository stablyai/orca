import { describe, expect, it, vi } from 'vitest'
import { openMobileNativeChatFileTap } from './mobile-native-chat-open-file'

function ok(result: unknown) {
  return { ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

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

function baseOptions(client: { sendRequest: ReturnType<typeof vi.fn> }) {
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
    await Promise.resolve()

    expect(sendRequest).toHaveBeenCalledWith(
      'files.resolveTerminalPath',
      { worktree: 'id:wt-1', pathText: 'src/app.ts', crossWorkspace: true },
      { timeoutMs: 10_000 }
    )
  })

  it('parses a :line:col citation and opens the mobile preview route', async () => {
    const sendRequest = vi.fn(async () => worktreeFileResolution('src/app.ts'))
    const options = baseOptions({ sendRequest })

    openMobileNativeChatFileTap({ ...options, pathText: 'src/app.ts:120:7' })
    await Promise.resolve()

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
    await Promise.resolve()
    await Promise.resolve()

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
    await Promise.resolve()
    await Promise.resolve()

    expect(options.onOpenFailed).toHaveBeenCalledTimes(1)
  })

  it('opens a plain path through files.open with tab activation', async () => {
    const responses: unknown[] = [worktreeFileResolution('src/app.ts'), ok({ opened: true })]
    const sendRequest = vi.fn(async () => responses.shift())
    const openedTab = { id: 'tab-2', relativePath: 'src/app.ts' }
    const switchSessionTab = vi.fn()
    const options = {
      ...baseOptions({ sendRequest }),
      getSessionTabs: () => [openedTab],
      getActiveSessionTabId: () => 'terminal-tab',
      switchSessionTab,
      scheduleDelayedAction: vi.fn((callback: () => void) => callback())
    }

    openMobileNativeChatFileTap({ ...options, pathText: 'src/app.ts' })
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sendRequest).toHaveBeenCalledWith(
      'files.open',
      { worktree: 'id:wt-1', relativePath: 'src/app.ts' },
      { timeoutMs: 15_000 }
    )
    expect(switchSessionTab).toHaveBeenCalledWith(openedTab)
    expect(options.onOpenFailed).not.toHaveBeenCalled()
  })
})
