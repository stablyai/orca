import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import type { UnvalidatedRpcRequestPort } from '../transport/unvalidated-rpc-request-port'
import { openMobileFileTap } from './mobile-file-tap-open'

// Why: a tap resolves its readings in parallel before opening, which spans several microtasks.
async function flushAsyncWork(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) {
    await Promise.resolve()
  }
}

type SendRequest = UnvalidatedRpcRequestPort['sendRequest']

function ok(result: unknown): RpcResponse {
  return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function createClient(responses: RpcResponse[]) {
  return {
    sendRequest: vi.fn<SendRequest>(async (method) => {
      const response = responses.shift()
      if (!response) {
        throw new Error(`no scripted response for ${method}`)
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
  it('opens absolute terminal artifacts through the grant-backed preview route', async () => {
    const client = createClient([
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
    ])
    const pushPreviewRoute = vi.fn()
    const triggerOpenFeedback = vi.fn()

    openMobileFileTap({
      client,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      pathText: '/tmp/result.json',
      terminalHandle: 'terminal-1',
      line: 12,
      column: 3,
      pushPreviewRoute,
      openBrowser: vi.fn(),
      triggerOpenFeedback,
      fetchSessionTabs: vi.fn(),
      getSessionTabs: () => [],
      getActiveSessionTabId: () => null,
      getActivationState: activeTerminalState,
      switchSessionTab: vi.fn(),
      scheduleDelayedAction: vi.fn()
    })
    await flushAsyncWork()

    expect(client.sendRequest).toHaveBeenCalledWith(
      'files.resolveTerminalPath',
      {
        worktree: 'id:wt-1',
        pathText: '/tmp/result.json',
        terminal: 'terminal-1',
        crossWorkspace: true
      },
      { timeoutMs: 10_000 }
    )
    expect(pushPreviewRoute).toHaveBeenCalledWith({
      pathname: '/h/[hostId]/files/preview/[worktreeId]',
      params: expect.objectContaining({
        hostId: 'host-1',
        worktreeId: 'wt-1',
        source: 'terminalArtifact',
        absolutePath: '/tmp/result.json',
        grantId: 'grant-1',
        pathText: '/tmp/result.json',
        terminal: 'terminal-1',
        line: '12',
        column: '3'
      })
    })
    expect(triggerOpenFeedback).toHaveBeenCalledTimes(1)
    expect(client.sendRequest).not.toHaveBeenCalledWith('files.open', expect.anything())
  })

  it('preserves the worktree-contained files.open flow', async () => {
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
    const scheduleDelayedAction = vi.fn((callback: () => void) => callback())
    const openedTab = { id: 'tab-2', relativePath: 'src/index.ts' }
    const switchSessionTab = vi.fn()

    openMobileFileTap({
      client,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      pathText: 'src/index.ts',
      line: null,
      column: null,
      pushPreviewRoute: vi.fn(),
      openBrowser: vi.fn(),
      triggerOpenFeedback: vi.fn(),
      fetchSessionTabs: vi.fn(),
      getSessionTabs: () => [openedTab],
      getActiveSessionTabId: () => 'terminal-tab',
      getActivationState: activeTerminalState,
      switchSessionTab,
      scheduleDelayedAction
    })
    await flushAsyncWork()
    await vi.advanceTimersByTimeAsync(0)

    expect(client.sendRequest).toHaveBeenCalledWith(
      'files.open',
      { worktree: 'id:wt-1', relativePath: 'src/index.ts' },
      { timeoutMs: 15_000 }
    )
    expect(switchSessionTab).toHaveBeenCalledWith(openedTab)
  })

  it('opens a sibling terminal path through the resolved owning worktree', async () => {
    const client = createClient([
      ok({
        worktree: 'wt-2',
        relativePath: 'docs/readme.md',
        absolutePath: '/repo-b/docs/readme.md',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'worktree-file',
          provider: 'local',
          relativePath: 'docs/readme.md',
          absolutePath: '/repo-b/docs/readme.md'
        }
      })
    ])
    const pushPreviewRoute = vi.fn()

    openMobileFileTap({
      client,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      pathText: '/repo-b/docs/readme.md',
      line: null,
      column: null,
      pushPreviewRoute,
      openBrowser: vi.fn(),
      triggerOpenFeedback: vi.fn(),
      fetchSessionTabs: vi.fn(),
      getSessionTabs: () => [],
      getActiveSessionTabId: () => null,
      getActivationState: activeTerminalState,
      switchSessionTab: vi.fn(),
      scheduleDelayedAction: vi.fn()
    })
    await flushAsyncWork()

    expect(pushPreviewRoute).toHaveBeenCalledWith({
      pathname: '/h/[hostId]/files/preview/[worktreeId]',
      params: expect.objectContaining({
        hostId: 'host-1',
        worktreeId: 'wt-2',
        source: 'worktree',
        relativePath: 'docs/readme.md'
      })
    })
    expect(client.sendRequest).not.toHaveBeenCalledWith('files.open', expect.anything())
  })

  it('opens worktree-contained line references through the preview route', async () => {
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
    const pushPreviewRoute = vi.fn()
    const triggerOpenFeedback = vi.fn()

    openMobileFileTap({
      client,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      worktreeName: 'Orca',
      pathText: 'src/index.ts:120:7',
      line: 120,
      column: 7,
      pushPreviewRoute,
      openBrowser: vi.fn(),
      triggerOpenFeedback,
      fetchSessionTabs: vi.fn(),
      getSessionTabs: () => [],
      getActiveSessionTabId: () => null,
      getActivationState: activeTerminalState,
      switchSessionTab: vi.fn(),
      scheduleDelayedAction: vi.fn()
    })
    await flushAsyncWork()

    expect(pushPreviewRoute).toHaveBeenCalledWith({
      pathname: '/h/[hostId]/files/preview/[worktreeId]',
      params: expect.objectContaining({
        hostId: 'host-1',
        worktreeId: 'wt-1',
        source: 'worktree',
        relativePath: 'src/index.ts',
        line: '120',
        column: '7',
        worktreeName: 'Orca'
      })
    })
    expect(triggerOpenFeedback).toHaveBeenCalledTimes(1)
    expect(client.sendRequest).not.toHaveBeenCalledWith('files.open', expect.anything())
  })

  it('encodes worktree HTML paths before opening a browser tab', async () => {
    const client = createClient([
      ok({
        worktree: 'wt-1',
        relativePath: 'public/report #1?.html',
        absolutePath: '/repo/public/report #1?.html',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'worktree-file',
          provider: 'local',
          relativePath: 'public/report #1?.html',
          absolutePath: '/repo/public/report #1?.html'
        }
      })
    ])
    const openBrowser = vi.fn()

    openMobileFileTap({
      client,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      pathText: 'public/report #1?.html',
      line: null,
      column: null,
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
    await flushAsyncWork()

    expect(openBrowser).toHaveBeenCalledWith('file:///repo/public/report%20%231%3F.html')
    expect(client.sendRequest).not.toHaveBeenCalledWith('files.open', expect.anything())
  })

  it('passes the terminal cwd when resolving relative taps', async () => {
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

    openMobileFileTap({
      client,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      pathText: 'index.ts',
      terminalHandle: 'term-1',
      cwd: '/repo/src',
      line: null,
      column: null,
      pushPreviewRoute: vi.fn(),
      openBrowser: vi.fn(),
      triggerOpenFeedback: vi.fn(),
      fetchSessionTabs: vi.fn(),
      getSessionTabs: () => [],
      getActiveSessionTabId: () => null,
      getActivationState: activeTerminalState,
      switchSessionTab: vi.fn(),
      scheduleDelayedAction: vi.fn()
    })
    await flushAsyncWork()

    expect(client.sendRequest).toHaveBeenCalledWith(
      'files.resolveTerminalPath',
      {
        worktree: 'id:wt-1',
        pathText: 'index.ts',
        terminal: 'term-1',
        cwd: '/repo/src',
        crossWorkspace: true
      },
      { timeoutMs: 10_000 }
    )
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
      pathText: 'report.html',
      line: null,
      column: null,
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
    await flushAsyncWork()

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
      pathText: '/tmp/result.json',
      terminalHandle: 'terminal-1',
      line: null,
      column: null,
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
    await flushAsyncWork()

    expect(pushPreviewRoute).not.toHaveBeenCalled()
  })

  it('opens the tapped path when a longer spaced reading does not exist', async () => {
    const client = createClient([
      ok({ worktree: 'wt-1', relativePath: null, absolutePath: null, exists: false }),
      ok({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: '/tmp/plan.md',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'absolute-file',
          provider: 'local',
          absolutePath: '/tmp/plan.md',
          grantId: 'grant-1'
        }
      })
    ])
    const pushPreviewRoute = vi.fn()

    openMobileFileTap({
      client,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      pathText: '/tmp/plan.md',
      longerCandidates: [{ pathText: '/tmp/plan.md. It covers and/or', line: null, column: null }],
      line: null,
      column: null,
      pushPreviewRoute,
      openBrowser: vi.fn(),
      triggerOpenFeedback: vi.fn(),
      fetchSessionTabs: vi.fn(),
      getSessionTabs: () => [],
      getActiveSessionTabId: () => null,
      getActivationState: activeTerminalState,
      switchSessionTab: vi.fn(),
      scheduleDelayedAction: vi.fn()
    })
    await flushAsyncWork()

    expect(client.sendRequest).toHaveBeenCalledTimes(2)
    expect(pushPreviewRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ absolutePath: '/tmp/plan.md', pathText: '/tmp/plan.md' })
      })
    )
  })

  it('reports a failed files.open through onOpenFailed', async () => {
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
      { id: 'rpc', ok: false, error: { code: 'runtime_error', message: 'nope' } }
    ])
    const onOpenFailed = vi.fn()

    openMobileFileTap({
      client,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      pathText: 'src/index.ts',
      line: null,
      column: null,
      pushPreviewRoute: vi.fn(),
      openBrowser: vi.fn(),
      triggerOpenFeedback: vi.fn(),
      fetchSessionTabs: vi.fn(),
      getSessionTabs: () => [],
      getActiveSessionTabId: () => null,
      getActivationState: activeTerminalState,
      switchSessionTab: vi.fn(),
      scheduleDelayedAction: vi.fn(),
      onOpenFailed
    })
    await flushAsyncWork()

    expect(onOpenFailed).toHaveBeenCalledTimes(1)
  })

  it('reports an unsupported file when files.open declines it', async () => {
    const client = createClient([
      ok({
        worktree: 'wt-1',
        relativePath: 'dist/app.zip',
        absolutePath: '/repo/dist/app.zip',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'worktree-file',
          provider: 'local',
          relativePath: 'dist/app.zip',
          absolutePath: '/repo/dist/app.zip'
        }
      }),
      ok({ worktree: 'wt-1', relativePath: 'dist/app.zip', kind: 'binary', opened: false })
    ])
    const onOpenFailed = vi.fn()
    const scheduleDelayedAction = vi.fn()

    openMobileFileTap({
      client,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      pathText: 'dist/app.zip',
      line: null,
      column: null,
      pushPreviewRoute: vi.fn(),
      openBrowser: vi.fn(),
      triggerOpenFeedback: vi.fn(),
      fetchSessionTabs: vi.fn(),
      getSessionTabs: () => [],
      getActiveSessionTabId: () => null,
      getActivationState: activeTerminalState,
      switchSessionTab: vi.fn(),
      scheduleDelayedAction,
      onOpenFailed
    })
    await flushAsyncWork()

    expect(onOpenFailed).toHaveBeenCalledTimes(1)
    expect(scheduleDelayedAction).not.toHaveBeenCalled()
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
      pathText: 'gone/missing.ts',
      line: null,
      column: null,
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
    await flushAsyncWork()

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
      pathText: 'src/index.ts',
      line: null,
      column: null,
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
    await flushAsyncWork()

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
      pathText: 'src/index.ts',
      line: null,
      column: null,
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
    await flushAsyncWork()
    callbacks.forEach((callback) => callback())
    await flushAsyncWork()

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
      pathText: 'src/index.ts',
      line: null,
      column: null,
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
