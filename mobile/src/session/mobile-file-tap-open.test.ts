import { describe, expect, it, vi } from 'vitest'
import { openMobileFileTap } from './mobile-file-tap-open'

function ok(result: unknown) {
  return { ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function createClient(responses: unknown[]) {
  return {
    sendRequest: vi.fn(async () => responses.shift())
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
    await Promise.resolve()

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
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

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
    await Promise.resolve()
    await Promise.resolve()

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

  it('opens worktree-contained line references through files.open and reveals the target line', async () => {
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
    const pushPreviewRoute = vi.fn()
    const triggerOpenFeedback = vi.fn()
    const onRevealFileLine = vi.fn()
    const scheduleDelayedAction = vi.fn((callback: () => void) => callback())
    const openedTab = { id: 'tab-2', relativePath: 'src/index.ts' }
    const switchSessionTab = vi.fn()

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
      getSessionTabs: () => [openedTab],
      getActiveSessionTabId: () => 'terminal-tab',
      getActivationState: activeTerminalState,
      switchSessionTab,
      scheduleDelayedAction,
      onRevealFileLine
    })
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(client.sendRequest).toHaveBeenCalledWith(
      'files.open',
      { worktree: 'id:wt-1', relativePath: 'src/index.ts', line: 120, column: 7 },
      { timeoutMs: 15_000 }
    )
    expect(onRevealFileLine).toHaveBeenCalledWith('src/index.ts', 120)
    expect(switchSessionTab).toHaveBeenCalledWith(openedTab)
    expect(triggerOpenFeedback).toHaveBeenCalledTimes(1)
    expect(pushPreviewRoute).not.toHaveBeenCalled()
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
    await Promise.resolve()

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
    await Promise.resolve()

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
    await Promise.resolve()
    await Promise.resolve()

    expect(openBrowser).not.toHaveBeenCalled()
    expect(client.sendRequest).toHaveBeenCalledWith(
      'files.open',
      { worktree: 'id:wt-1', relativePath: 'report.html' },
      { timeoutMs: 15_000 }
    )
  })

  it('does not navigate an absolute artifact after the user leaves the source terminal', async () => {
    let resolveRequest: (value: unknown) => void = () => {}
    const client = {
      sendRequest: vi.fn(
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
    await Promise.resolve()
    await Promise.resolve()

    expect(pushPreviewRoute).not.toHaveBeenCalled()
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
      { ok: false, error: { message: 'nope' } }
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
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

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
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

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
    await Promise.resolve()
    await Promise.resolve()

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
    await Promise.resolve()
    await Promise.resolve()

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
    await Promise.resolve()
    await Promise.resolve()
    callbacks.forEach((callback) => callback())
    await Promise.resolve()

    expect(switchSessionTab).not.toHaveBeenCalled()
  })

  it('does not reveal a stale file line when a newer tap supersedes an in-flight files.open', async () => {
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
    let latestActivationSeq = 1
    client.sendRequest.mockImplementation(async (method: string) => {
      if (method === 'files.open') {
        latestActivationSeq = 2
        return ok({ opened: true })
      }
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
    })
    const onRevealFileLine = vi.fn()

    openMobileFileTap({
      client,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      pathText: 'src/index.ts:12',
      line: 12,
      column: null,
      pushPreviewRoute: vi.fn(),
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
      onRevealFileLine
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onRevealFileLine).not.toHaveBeenCalled()
  })

  async function tapOnHostWithNoDesktopWindow(options: { leaveDuringOpen: boolean }) {
    let latestActivationSeq = 1
    const client = {
      sendRequest: vi.fn(async (method: string) => {
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
        return { ok: false, error: { code: 'runtime_error', message: 'renderer_unavailable' } }
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
    await new Promise((resolve) => setTimeout(resolve, 0))

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

  it('gates opening behind confirmResolvedOpen when provided and completes on proceed', async () => {
    const client = createClient([
      ok({
        worktree: 'wt-1',
        relativePath: 'src/note.md',
        absolutePath: 'C:/repo/src/note.md',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'worktree-file',
          provider: 'local',
          relativePath: 'src/note.md',
          absolutePath: 'C:/repo/src/note.md'
        }
      }),
      ok({ opened: true })
    ])
    const pushPreviewRoute = vi.fn()
    const triggerOpenFeedback = vi.fn()
    let proceedOpen: (() => void) | null = null
    const confirmResolvedOpen = vi.fn((_target, proceed: () => void) => {
      proceedOpen = proceed
    })

    openMobileFileTap({
      client,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      pathText: 'src/note.md',
      terminalHandle: 'terminal-1',
      line: 15,
      column: 2,
      pushPreviewRoute,
      openBrowser: vi.fn(),
      triggerOpenFeedback,
      fetchSessionTabs: vi.fn(),
      getSessionTabs: () => [],
      getActiveSessionTabId: () => null,
      getActivationState: activeTerminalState,
      switchSessionTab: vi.fn(),
      scheduleDelayedAction: vi.fn(),
      confirmResolvedOpen
    })
    await Promise.resolve()

    expect(confirmResolvedOpen).toHaveBeenCalledWith(
      {
        title: 'note.md',
        displayPath: 'src/note.md:15:2',
        copyPath: 'C:/repo/src/note.md'
      },
      expect.any(Function)
    )
    expect(client.sendRequest).not.toHaveBeenCalledWith(
      'files.open',
      expect.anything(),
      expect.anything()
    )
    expect(triggerOpenFeedback).toHaveBeenCalledTimes(1)

    proceedOpen!()
    await Promise.resolve()

    expect(client.sendRequest).toHaveBeenCalledWith(
      'files.open',
      { worktree: 'id:wt-1', relativePath: 'src/note.md', line: 15, column: 2 },
      { timeoutMs: 15_000 }
    )
    expect(pushPreviewRoute).not.toHaveBeenCalled()
    expect(triggerOpenFeedback).toHaveBeenCalledTimes(1)
  })
})
