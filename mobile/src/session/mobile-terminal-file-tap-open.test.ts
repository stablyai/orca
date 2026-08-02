import { describe, expect, it, vi } from 'vitest'
import { openMobileTerminalFileTap } from './mobile-terminal-file-tap-open'

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

describe('openMobileTerminalFileTap', () => {
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

    openMobileTerminalFileTap({
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
      { worktree: 'id:wt-1', pathText: '/tmp/result.json', terminal: 'terminal-1' },
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

    openMobileTerminalFileTap({
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

    openMobileTerminalFileTap({
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
    await Promise.resolve()

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

    openMobileTerminalFileTap({
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

    openMobileTerminalFileTap({
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
      { worktree: 'id:wt-1', pathText: 'index.ts', terminal: 'term-1', cwd: '/repo/src' },
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

    openMobileTerminalFileTap({
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

    openMobileTerminalFileTap({
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

    openMobileTerminalFileTap({
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
})
