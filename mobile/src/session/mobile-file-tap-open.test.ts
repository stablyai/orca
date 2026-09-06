import { describe, expect, it, vi } from 'vitest'
import type { HostSessionTerminalFileTarget } from './host-session-terminal-file-operations'
import { openMobileFileTap as openMobileTerminalFileTap } from './mobile-file-tap-open'

function createOperations(targets: (HostSessionTerminalFileTarget | null)[]) {
  return {
    resolveTerminalPath: vi.fn(async () => targets.shift()),
    openWorktreeFile: vi.fn(async () => {})
  }
}

function worktreeTarget(relativePath: string, localAbsolutePath: string | null) {
  return { kind: 'worktree-file' as const, relativePath, localAbsolutePath }
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
    const operations = createOperations([
      {
        kind: 'native-artifact',
        absolutePath: '/tmp/result.json',
        grantId: 'grant-1'
      }
    ])
    const pushPreviewRoute = vi.fn()
    const triggerOpenFeedback = vi.fn()

    openMobileTerminalFileTap({
      operations,
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

    expect(operations.resolveTerminalPath).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'wt-1',
        pathText: '/tmp/result.json',
        terminalHandle: 'terminal-1'
      })
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
    expect(operations.openWorktreeFile).not.toHaveBeenCalled()
  })

  it('preserves the worktree-contained files.open flow', async () => {
    const operations = createOperations([worktreeTarget('src/index.ts', '/repo/src/index.ts')])
    const scheduleDelayedAction = vi.fn((callback: () => void) => callback())
    const openedTab = { id: 'tab-2', relativePath: 'src/index.ts' }
    const switchSessionTab = vi.fn()

    openMobileTerminalFileTap({
      operations,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      pathText: 'src/index.ts',
      terminalHandle: 'terminal-1',
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

    expect(operations.openWorktreeFile).toHaveBeenCalledWith('wt-1', 'src/index.ts')
    expect(switchSessionTab).toHaveBeenCalledWith(openedTab)
  })

  it('opens a sibling-workspace path through the resolved owning workspace', async () => {
    const operations = createOperations([
      {
        kind: 'worktree-file' as const,
        relativePath: 'docs/readme.md',
        localAbsolutePath: '/repo-b/docs/readme.md',
        workspaceId: 'wt-2'
      }
    ])
    const pushPreviewRoute = vi.fn()

    openMobileTerminalFileTap({
      operations,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      worktreeName: 'workspace one',
      pathText: '/repo-b/docs/readme.md',
      terminalHandle: 'terminal-1',
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

    // Opening it in this session's workspace would hit a same-named file or nothing.
    expect(pushPreviewRoute).toHaveBeenCalledWith({
      pathname: '/h/[hostId]/files/preview/[worktreeId]',
      params: expect.objectContaining({
        hostId: 'host-1',
        worktreeId: 'wt-2',
        source: 'worktree',
        relativePath: 'docs/readme.md'
      })
    })
    expect(pushPreviewRoute.mock.calls[0]?.[0].params).not.toHaveProperty('worktreeName')
    expect(operations.openWorktreeFile).not.toHaveBeenCalled()
  })

  it('addresses files.open at the workspace the host resolved', async () => {
    const operations = createOperations([
      {
        kind: 'worktree-file' as const,
        relativePath: 'src/index.ts',
        localAbsolutePath: '/repo/src/index.ts',
        workspaceId: 'wt-1'
      }
    ])

    openMobileTerminalFileTap({
      operations,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      pathText: 'src/index.ts',
      terminalHandle: 'terminal-1',
      line: null,
      column: null,
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
    await Promise.resolve()
    await Promise.resolve()

    expect(operations.openWorktreeFile).toHaveBeenCalledWith('wt-1', 'src/index.ts')
  })

  it('opens the file when optional haptic feedback is unavailable', async () => {
    const operations = createOperations([worktreeTarget('README.md', '/repo/README.md')])

    openMobileTerminalFileTap({
      operations,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      pathText: 'README.md',
      terminalHandle: 'terminal-1',
      line: null,
      column: null,
      pushPreviewRoute: vi.fn(),
      openBrowser: vi.fn(),
      triggerOpenFeedback: () => {
        throw new Error('haptics unavailable')
      },
      fetchSessionTabs: vi.fn(),
      getSessionTabs: () => [],
      getActiveSessionTabId: () => 'terminal-tab',
      getActivationState: activeTerminalState,
      switchSessionTab: vi.fn(),
      scheduleDelayedAction: vi.fn()
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(operations.openWorktreeFile).toHaveBeenCalledWith('wt-1', 'README.md')
  })

  it('opens worktree-contained line references through the preview route', async () => {
    const operations = createOperations([worktreeTarget('src/index.ts', '/repo/src/index.ts')])
    const pushPreviewRoute = vi.fn()
    const triggerOpenFeedback = vi.fn()

    openMobileTerminalFileTap({
      operations,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      worktreeName: 'Orca',
      pathText: 'src/index.ts:120:7',
      terminalHandle: 'terminal-1',
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
    expect(operations.openWorktreeFile).not.toHaveBeenCalled()
  })

  it('encodes worktree HTML paths before opening a browser tab', async () => {
    const operations = createOperations([
      worktreeTarget('public/report #1?.html', '/repo/public/report #1?.html')
    ])
    const openBrowser = vi.fn()

    openMobileTerminalFileTap({
      operations,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      pathText: 'public/report #1?.html',
      terminalHandle: 'terminal-1',
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
    expect(operations.openWorktreeFile).not.toHaveBeenCalled()
  })

  it('passes the terminal cwd when resolving relative taps', async () => {
    const operations = createOperations([worktreeTarget('src/index.ts', '/repo/src/index.ts')])

    openMobileTerminalFileTap({
      operations,
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

    expect(operations.resolveTerminalPath).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'wt-1',
        pathText: 'index.ts',
        terminalHandle: 'term-1',
        cwd: '/repo/src'
      })
    )
  })

  it('does not open SSH worktree HTML paths as local browser file URLs', async () => {
    const operations = createOperations([worktreeTarget('report.html', null)])
    const openBrowser = vi.fn()

    openMobileTerminalFileTap({
      operations,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      pathText: 'report.html',
      terminalHandle: 'terminal-1',
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
    expect(operations.openWorktreeFile).toHaveBeenCalledWith('wt-1', 'report.html')
  })

  it('does not navigate an absolute artifact after the user leaves the source terminal', async () => {
    let resolveRequest: (value: unknown) => void = () => {}
    const operations = {
      resolveTerminalPath: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRequest = resolve
          })
      ),
      openWorktreeFile: vi.fn()
    }
    let activeTerminalHandle: string | null = 'terminal-1'
    const pushPreviewRoute = vi.fn()

    openMobileTerminalFileTap({
      operations,
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
    resolveRequest({
      kind: 'native-artifact',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-1'
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(pushPreviewRoute).not.toHaveBeenCalled()
  })

  it('reports a failed files.open through onOpenFailed', async () => {
    const operations = createOperations([worktreeTarget('src/index.ts', '/repo/src/index.ts')])
    operations.openWorktreeFile.mockRejectedValue(new Error('nope'))
    const onOpenFailed = vi.fn()

    openMobileTerminalFileTap({
      operations,
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
    const operations = createOperations([worktreeTarget('dist/app.zip', '/repo/dist/app.zip')])
    operations.openWorktreeFile.mockRejectedValue(new Error('unsupported'))
    const onOpenFailed = vi.fn()
    const scheduleDelayedAction = vi.fn()

    openMobileTerminalFileTap({
      operations,
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
    const operations = createOperations([null])
    const onOpenFailed = vi.fn()

    openMobileTerminalFileTap({
      operations,
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
    const operations = createOperations([worktreeTarget('src/index.ts', '/repo/src/index.ts')])
    const onOpenFailed = vi.fn()

    openMobileTerminalFileTap({
      operations,
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
    const operations = createOperations([worktreeTarget('src/index.ts', '/repo/src/index.ts')])
    const callbacks: (() => void)[] = []
    const openedTab = { id: 'tab-2', relativePath: 'src/index.ts' }
    const switchSessionTab = vi.fn()

    openMobileTerminalFileTap({
      operations,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      pathText: 'src/index.ts',
      terminalHandle: 'terminal-1',
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
