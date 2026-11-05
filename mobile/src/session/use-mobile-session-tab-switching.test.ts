import { describe, expect, it, vi } from 'vitest'

const tabActivation = vi.hoisted(() => ({
  activateMobileSessionTab: vi.fn(() => Promise.resolve({ ok: true, result: null }))
}))
vi.mock('../platform/haptics', () => ({
  triggerSelection: vi.fn()
}))
vi.mock('./mobile-session-tab-activation', () => tabActivation)
import { hookMount, performHookAction } from '../test-support/rpc-recording/hook-mount'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import { MobileTerminalDiagnostics } from './mobile-terminal-diagnostics'
import type { FileDocState, MarkdownDocState, MobileSessionTab } from './mobile-session-route-types'
import { isCachedActiveDocumentRetap } from './mobile-session-active-document-retap'
import { useMobileSessionTabSwitching } from './use-mobile-session-tab-switching'

const markdownTab: MobileSessionTab = {
  type: 'markdown',
  id: 'md',
  title: 'Notes',
  filePath: '/Notes.md',
  relativePath: 'Notes.md',
  isDirty: false,
  isActive: true,
  documentVersion: 'v1'
}

const fileTab: MobileSessionTab = {
  type: 'file',
  id: 'file',
  title: 'Main',
  filePath: '/Main.ts',
  relativePath: 'Main.ts',
  isDirty: false,
  isActive: true
}

const readyMarkdown: MarkdownDocState = {
  status: 'ready',
  content: '# Notes',
  localContent: '# Notes',
  baseVersion: 'v1',
  isDirty: false,
  editable: true
}

function mountSwitching(args: {
  activeSessionTabId: string | null
  markdownDocs?: Map<string, MarkdownDocState>
  fileDocs?: Map<string, FileDocState>
  sessionTabs?: MobileSessionTab[]
  activeHandle?: string | null
  subscribedHandles?: readonly string[]
  visibleHandles?: readonly string[]
  client?: object | null
  worktreeId?: string
}) {
  const readMarkdownTab = vi.fn()
  const readFileTab = vi.fn()
  const setActiveSessionTabId = vi.fn()
  const setActiveHandle = vi.fn()
  const unsubscribeTerminal = vi.fn()
  const subscribeToTerminal = vi.fn()
  const setSplitTerminalHandles = vi.fn()
  const activeHandleRef = { current: args.activeHandle ?? null }
  const terminalUnsubsRef = {
    current: new Map((args.subscribedHandles ?? []).map((handle) => [handle, () => {}]))
  }
  const visibleTerminalHandlesRef = { current: [...(args.visibleHandles ?? [])] }
  let switching: ReturnType<typeof useMobileSessionTabSwitching> | undefined
  const hook = hookMount(() => {
    switching = useMobileSessionTabSwitching(
      mountFixture<Parameters<typeof useMobileSessionTabSwitching>[0]>({
        activeSessionTabId: args.activeSessionTabId,
        markdownDocs: args.markdownDocs ?? new Map<string, MarkdownDocState>(),
        fileDocs: args.fileDocs ?? new Map<string, FileDocState>(),
        readMarkdownTab,
        readFileTab,
        setActiveSessionTabId,
        setActiveHandle,
        switchSessionTabRef: { current: null },
        terminalDiagnosticsRef: { current: new MobileTerminalDiagnostics() },
        pendingSelectionRef: { current: null },
        activeSessionTabTypeRef: { current: null },
        activeHandleRef,
        terminalUnsubsRef,
        visibleTerminalHandlesRef,
        unsubscribeTerminal,
        subscribeToTerminal,
        setSplitTerminalHandles,
        client: args.client === undefined ? null : args.client,
        sessionTabs: args.sessionTabs ?? [],
        worktreeId: args.worktreeId
      })
    )
  })
  hook.mount()
  return {
    readMarkdownTab,
    readFileTab,
    setActiveSessionTabId,
    setActiveHandle,
    unsubscribeTerminal,
    subscribeToTerminal,
    setSplitTerminalHandles,
    switchTo: (tab: MobileSessionTab) => {
      performHookAction(() => switching?.switchSessionTab(tab))
    },
    unmount: hook.unmount
  }
}

describe('isCachedActiveDocumentRetap', () => {
  it('ignores a retap only while the open markdown or file document is already on screen', () => {
    const docs = {
      markdownDocs: new Map<string, MarkdownDocState>([['md', readyMarkdown]]),
      fileDocs: new Map<string, FileDocState>([
        ['file', { status: 'ready', kind: 'html', content: '<p>Hi</p>' }]
      ])
    }
    expect(isCachedActiveDocumentRetap(markdownTab, 'md', docs)).toBe(true)
    expect(isCachedActiveDocumentRetap(fileTab, 'file', docs)).toBe(true)
    expect(isCachedActiveDocumentRetap(markdownTab, 'other', docs)).toBe(false)
    expect(
      isCachedActiveDocumentRetap(markdownTab, 'md', {
        ...docs,
        markdownDocs: new Map([['md', { status: 'error', message: 'Missing' }]])
      })
    ).toBe(false)
    expect(
      isCachedActiveDocumentRetap(
        {
          type: 'terminal',
          id: 'term',
          title: 'Shell',
          terminal: 'pty-1',
          isActive: true
        },
        'term',
        docs
      )
    ).toBe(false)
  })
})

describe('useMobileSessionTabSwitching active document retap', () => {
  it('does not reload the markdown tab that is already showing', () => {
    const harness = mountSwitching({
      activeSessionTabId: 'md',
      markdownDocs: new Map([['md', readyMarkdown]])
    })
    try {
      harness.switchTo(markdownTab)
      expect(harness.readMarkdownTab).not.toHaveBeenCalled()
      expect(harness.setActiveSessionTabId).not.toHaveBeenCalled()
    } finally {
      harness.unmount()
    }
  })

  it('does not reload a file tab that is already showing', () => {
    const harness = mountSwitching({
      activeSessionTabId: 'file',
      fileDocs: new Map([['file', { status: 'loading' }]])
    })
    try {
      harness.switchTo(fileTab)
      expect(harness.readFileTab).not.toHaveBeenCalled()
      expect(harness.setActiveSessionTabId).not.toHaveBeenCalled()
    } finally {
      harness.unmount()
    }
  })

  it('rereads a cached markdown tab when switching back to it', () => {
    const harness = mountSwitching({
      activeSessionTabId: 'file',
      markdownDocs: new Map([['md', readyMarkdown]])
    })
    try {
      harness.switchTo(markdownTab)
      expect(harness.readMarkdownTab).toHaveBeenCalledExactlyOnceWith(markdownTab)
      expect(harness.setActiveSessionTabId).toHaveBeenCalledExactlyOnceWith('md')
    } finally {
      harness.unmount()
    }
  })

  it('rereads the open markdown tab after its document failed', () => {
    const harness = mountSwitching({
      activeSessionTabId: 'md',
      markdownDocs: new Map([['md', { status: 'error', message: 'Missing' }]])
    })
    try {
      harness.switchTo(markdownTab)
      expect(harness.readMarkdownTab).toHaveBeenCalledOnce()
    } finally {
      harness.unmount()
    }
  })
})

const liveTerminal: MobileSessionTab = {
  type: 'terminal',
  id: 'term',
  title: 'Shell',
  terminal: 'pty-1',
  isActive: true
}

const otherTerminal: MobileSessionTab = {
  type: 'terminal',
  id: 'term-2',
  title: 'Other',
  terminal: 'pty-2',
  isActive: false
}

const browserTab: MobileSessionTab = {
  type: 'browser',
  id: 'browser',
  title: 'Docs',
  browserWorkspaceId: 'bw',
  browserPageId: null,
  url: 'https://example.com',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  isActive: true
}

const agentTab: MobileSessionTab = {
  type: 'agent-session',
  id: 'agent',
  title: 'Agent',
  sessionId: 'sess',
  agent: 'codex',
  isActive: true
}

describe('useMobileSessionTabSwitching live surface retap', () => {
  function mountLive(args: {
    tab: MobileSessionTab
    activeHandle: string | null
    subscribedHandles?: readonly string[]
    visibleHandles?: readonly string[]
    sessionTabs?: MobileSessionTab[]
  }) {
    tabActivation.activateMobileSessionTab.mockClear()
    return mountSwitching({
      activeSessionTabId: args.tab.id,
      activeHandle: args.activeHandle,
      subscribedHandles: args.subscribedHandles,
      visibleHandles: args.visibleHandles,
      sessionTabs: args.sessionTabs ?? [args.tab],
      client: {},
      worktreeId: 'wt'
    })
  }

  it('does not tear down or reactivate a subscribed terminal that is already showing', () => {
    const harness = mountLive({
      tab: liveTerminal,
      activeHandle: 'pty-1',
      subscribedHandles: ['pty-1']
    })
    try {
      harness.switchTo(liveTerminal)
      expect(harness.unsubscribeTerminal).not.toHaveBeenCalled()
      expect(harness.subscribeToTerminal).not.toHaveBeenCalled()
      expect(harness.setActiveSessionTabId).not.toHaveBeenCalled()
      expect(tabActivation.activateMobileSessionTab).not.toHaveBeenCalled()
    } finally {
      harness.unmount()
    }
  })

  it('does not reactivate an open browser or agent tab', () => {
    const browser = mountLive({ tab: browserTab, activeHandle: null })
    const agent = mountLive({ tab: agentTab, activeHandle: null })
    try {
      browser.switchTo(browserTab)
      agent.switchTo(agentTab)
      expect(browser.setActiveSessionTabId).not.toHaveBeenCalled()
      expect(agent.setActiveHandle).not.toHaveBeenCalled()
      expect(tabActivation.activateMobileSessionTab).not.toHaveBeenCalled()
    } finally {
      browser.unmount()
      agent.unmount()
    }
  })

  it('still subscribes and activates when the tapped terminal is not the live one', () => {
    const harness = mountLive({
      tab: otherTerminal,
      activeHandle: 'pty-1',
      subscribedHandles: ['pty-1'],
      sessionTabs: [liveTerminal, otherTerminal]
    })
    try {
      harness.switchTo(otherTerminal)
      expect(harness.unsubscribeTerminal).toHaveBeenCalledWith('pty-1')
      expect(harness.subscribeToTerminal).toHaveBeenCalledWith('pty-2')
      expect(tabActivation.activateMobileSessionTab).toHaveBeenCalledOnce()
    } finally {
      harness.unmount()
    }
  })

  it('still moves a subscribed terminal that is hidden by the other split pane', () => {
    const harness = mountLive({
      tab: liveTerminal,
      activeHandle: 'pty-1',
      subscribedHandles: ['pty-1'],
      visibleHandles: ['pty-2', 'pty-3']
    })
    try {
      harness.switchTo(liveTerminal)
      expect(harness.subscribeToTerminal).toHaveBeenCalledWith('pty-1')
      expect(harness.setSplitTerminalHandles).toHaveBeenCalledWith(['pty-1', 'pty-2'])
      expect(tabActivation.activateMobileSessionTab).toHaveBeenCalledOnce()
    } finally {
      harness.unmount()
    }
  })
})
