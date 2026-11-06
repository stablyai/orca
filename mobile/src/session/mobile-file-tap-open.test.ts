import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import type { UnvalidatedRpcRequestPort } from '../transport/unvalidated-rpc-request-port'
import { openMobileFileTap } from './mobile-file-tap-open'

type SendRequest = UnvalidatedRpcRequestPort['sendRequest']

function ok(result: unknown): RpcResponse {
  return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function createClient(responses: (RpcResponse | Error)[]) {
  return {
    sendRequest: vi.fn<SendRequest>(async (method) => {
      const response = responses.shift()
      if (!response) {
        throw new Error(`no scripted response for ${method}`)
      }
      if (response instanceof Error) {
        throw response
      }
      return response
    })
  }
}

function activeTerminalState(activated: boolean) {
  return {
    activated,
    activationSeq: 1,
    latestActivationSeq: 1,
    sourceTerminalHandle: 'terminal-1',
    activeTerminalHandle: 'terminal-1',
    activeTabType: 'terminal'
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('openMobileFileTap', () => {
  // Answers like the mobile page bridge, which refuses past 64 pending requests.
  async function openTerminalReadings(readings: string[], existing: Set<string>) {
    let pending = 0
    const client = {
      sendRequest: vi.fn<SendRequest>(async (method, params) => {
        if (method === 'files.open') {
          return ok({ opened: true })
        }
        if (pending >= 64) {
          throw new Error('too many pending requests')
        }
        pending += 1
        await Promise.resolve()
        pending -= 1
        const pathText =
          typeof params === 'object' && params !== null && 'pathText' in params
            ? String(params.pathText)
            : ''
        return ok({
          worktree: 'wt-1',
          relativePath: pathText,
          absolutePath: `/repo/${pathText}`,
          exists: existing.has(pathText),
          isDirectory: false
        })
      })
    }
    openMobileFileTap({
      client,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      candidates: readings.map((pathText) => ({ pathText, line: null, column: null })),
      pushPreviewRoute: vi.fn(),
      openBrowser: vi.fn(),
      triggerOpenFeedback: vi.fn(),
      fetchSessionTabs: vi.fn(),
      getSessionTabs: () => [],
      getActiveSessionTabId: () => 'terminal-tab',
      getActivationState: activeTerminalState,
      switchSessionTab: vi.fn(),
      scheduleDelayedAction: vi.fn()
    })
    await vi.advanceTimersByTimeAsync(0)
    return client.sendRequest.mock.calls
      .filter(([method]) => method === 'files.open')
      .map(([, params]) => params)
  }

  it('opens the longest terminal reading that exists, as desktop does', async () => {
    const opened = await openTerminalReadings(
      ['src/index.ts', 'src/index.ts.map', 'src/index.ts.map.bak'],
      new Set(['src/index.ts', 'src/index.ts.map'])
    )
    expect(opened).toEqual([{ worktree: 'id:wt-1', relativePath: 'src/index.ts.map' }])
  })

  it('still checks the real path behind hundreds of hard-wrap guesses', async () => {
    const guesses = Array.from({ length: 210 }, (_, index) => `src/file${index}.tssrc/next.ts`)
    const opened = await openTerminalReadings(
      [...guesses, 'src/file19.ts'],
      new Set(['src/file19.ts'])
    )
    expect(opened).toEqual([{ worktree: 'id:wt-1', relativePath: 'src/file19.ts' }])
  })

  it('does not open SSH worktree HTML paths as local browser file URLs', async () => {
    const client = createClient([
      ok({
        worktree: 'wt-1',
        relativePath: 'report.html',
        absolutePath: '/home/me/repo/report.html',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'worktree-file',
          provider: 'ssh',
          relativePath: 'report.html',
          absolutePath: '/home/me/repo/report.html'
        }
      }),
      ok({ opened: true })
    ])
    const openBrowser = vi.fn()

    openMobileFileTap({
      client,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      candidates: [{ pathText: 'report.html', line: null, column: null }],
      pushPreviewRoute: vi.fn(),
      openBrowser,
      triggerOpenFeedback: vi.fn(),
      fetchSessionTabs: vi.fn(),
      getSessionTabs: () => [],
      getActiveSessionTabId: () => null,
      getActivationState: activeTerminalState,
      switchSessionTab: vi.fn(),
      scheduleDelayedAction: vi.fn()
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(openBrowser).not.toHaveBeenCalled()
    expect(client.sendRequest).toHaveBeenCalledWith(
      'files.open',
      { worktree: 'id:wt-1', relativePath: 'report.html' },
      { timeoutMs: 15_000 }
    )
  })

  it('does not navigate an absolute artifact after the user leaves the source terminal', async () => {
    let resolveRequest: (value: RpcResponse) => void = () => {}
    const client = {
      sendRequest: vi.fn<SendRequest>(
        () =>
          new Promise((resolve) => {
            resolveRequest = resolve
          })
      )
    }
    let activeTerminalHandle: string | null = 'terminal-1'
    const pushPreviewRoute = vi.fn()

    openMobileFileTap({
      client,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      candidates: [{ pathText: '/tmp/result.json', line: null, column: null }],
      terminalHandle: 'terminal-1',
      pushPreviewRoute,
      openBrowser: vi.fn(),
      triggerOpenFeedback: vi.fn(),
      fetchSessionTabs: vi.fn(),
      getSessionTabs: () => [],
      getActiveSessionTabId: () => null,
      getActivationState: (activated) => ({
        ...activeTerminalState(activated),
        activeTerminalHandle
      }),
      switchSessionTab: vi.fn(),
      scheduleDelayedAction: vi.fn()
    })

    activeTerminalHandle = 'terminal-2'
    resolveRequest(
      ok({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: '/tmp/result.json',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'absolute-file',
          provider: 'local',
          absolutePath: '/tmp/result.json',
          grantId: 'grant-1'
        }
      })
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(pushPreviewRoute).not.toHaveBeenCalled()
  })

  it('does not report a stale failure after a newer tap supersedes it', async () => {
    const client = createClient([
      ok({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: null,
        exists: false,
        isDirectory: false
      })
    ])
    const onOpenFailed = vi.fn()

    openMobileFileTap({
      client,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      candidates: [{ pathText: 'gone/missing.ts', line: null, column: null }],
      pushPreviewRoute: vi.fn(),
      openBrowser: vi.fn(),
      triggerOpenFeedback: vi.fn(),
      fetchSessionTabs: vi.fn(),
      getSessionTabs: () => [],
      getActiveSessionTabId: () => null,
      getActivationState: (activated) => ({
        ...activeTerminalState(activated),
        latestActivationSeq: 2
      }),
      switchSessionTab: vi.fn(),
      scheduleDelayedAction: vi.fn(),
      onOpenFailed
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(onOpenFailed).not.toHaveBeenCalled()
  })

  it('does not report a failure when the user left the source tab mid-resolve', async () => {
    const client = createClient([
      ok({
        worktree: 'wt-1',
        relativePath: 'src/index.ts',
        absolutePath: '/repo/src/index.ts',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'worktree-file',
          provider: 'local',
          relativePath: 'src/index.ts',
          absolutePath: '/repo/src/index.ts'
        }
      })
    ])
    const onOpenFailed = vi.fn()

    openMobileFileTap({
      client,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      candidates: [{ pathText: 'src/index.ts', line: null, column: null }],
      pushPreviewRoute: vi.fn(),
      openBrowser: vi.fn(),
      triggerOpenFeedback: vi.fn(),
      fetchSessionTabs: vi.fn(),
      getSessionTabs: () => [],
      getActiveSessionTabId: () => null,
      getActivationState: (activated) => ({
        ...activeTerminalState(activated),
        activeTerminalHandle: 'terminal-2'
      }),
      switchSessionTab: vi.fn(),
      scheduleDelayedAction: vi.fn(),
      onOpenFailed
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(onOpenFailed).not.toHaveBeenCalled()
  })

  it('does not activate a worktree file tab after a newer tap supersedes it', async () => {
    const client = createClient([
      ok({
        worktree: 'wt-1',
        relativePath: 'src/index.ts',
        absolutePath: '/repo/src/index.ts',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'worktree-file',
          provider: 'local',
          relativePath: 'src/index.ts',
          absolutePath: '/repo/src/index.ts'
        }
      }),
      ok({ opened: true })
    ])
    const callbacks: (() => void)[] = []
    const openedTab = { id: 'tab-2', relativePath: 'src/index.ts' }
    const switchSessionTab = vi.fn()

    openMobileFileTap({
      client,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      candidates: [{ pathText: 'src/index.ts', line: null, column: null }],
      pushPreviewRoute: vi.fn(),
      openBrowser: vi.fn(),
      triggerOpenFeedback: vi.fn(),
      fetchSessionTabs: vi.fn(),
      getSessionTabs: () => [openedTab],
      getActiveSessionTabId: () => 'terminal-tab',
      getActivationState: (activated) => ({
        ...activeTerminalState(activated),
        latestActivationSeq: 2
      }),
      switchSessionTab,
      scheduleDelayedAction: (callback) => callbacks.push(callback)
    })
    await vi.advanceTimersByTimeAsync(0)
    callbacks.forEach((callback) => callback())
    await vi.advanceTimersByTimeAsync(0)

    expect(switchSessionTab).not.toHaveBeenCalled()
  })

  async function tapOnHostWithNoDesktopWindow(options: { leaveDuringOpen: boolean }) {
    let latestActivationSeq = 1
    const client = {
      sendRequest: vi.fn<SendRequest>(async (method) => {
        if (method !== 'files.open') {
          return ok({
            worktree: 'wt-1',
            relativePath: 'src/index.ts',
            absolutePath: '/repo/src/index.ts',
            exists: true,
            isDirectory: false,
            openTarget: {
              kind: 'worktree-file',
              provider: 'local',
              relativePath: 'src/index.ts',
              absolutePath: '/repo/src/index.ts'
            }
          })
        }
        if (options.leaveDuringOpen) {
          latestActivationSeq = 2
        }
        return {
          id: 'rpc',
          ok: false,
          error: { code: 'runtime_error', message: 'renderer_unavailable' }
        }
      })
    }
    const pushPreviewRoute = vi.fn()
    const onOpenFailed = vi.fn()

    openMobileFileTap({
      client,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      worktreeName: 'api',
      candidates: [{ pathText: 'src/index.ts', line: null, column: null }],
      pushPreviewRoute,
      openBrowser: vi.fn(),
      triggerOpenFeedback: vi.fn(),
      fetchSessionTabs: vi.fn(),
      getSessionTabs: () => [],
      getActiveSessionTabId: () => 'terminal-tab',
      getActivationState: (activated) => ({
        ...activeTerminalState(activated),
        latestActivationSeq
      }),
      switchSessionTab: vi.fn(),
      scheduleDelayedAction: vi.fn(),
      onOpenFailed
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(client.sendRequest).toHaveBeenCalledWith(
      'files.open',
      { worktree: 'id:wt-1', relativePath: 'src/index.ts' },
      { timeoutMs: 15_000 }
    )
    expect(onOpenFailed).not.toHaveBeenCalled()
    return pushPreviewRoute
  }

  it('previews a tapped worktree file when the host has no desktop window', async () => {
    const pushPreviewRoute = await tapOnHostWithNoDesktopWindow({ leaveDuringOpen: false })

    expect(pushPreviewRoute).toHaveBeenCalledWith({
      pathname: '/h/[hostId]/files/preview/[worktreeId]',
      params: expect.objectContaining({
        hostId: 'host-1',
        worktreeId: 'wt-1',
        source: 'worktree',
        relativePath: 'src/index.ts',
        worktreeName: 'api'
      })
    })
  })

  it('does not push the preview once the user has moved on during the open call', async () => {
    const pushPreviewRoute = await tapOnHostWithNoDesktopWindow({ leaveDuringOpen: true })

    expect(pushPreviewRoute).not.toHaveBeenCalled()
  })
})
