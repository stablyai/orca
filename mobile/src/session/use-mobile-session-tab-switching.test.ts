import { describe, expect, it, vi } from 'vitest'

vi.mock('../platform/haptics', () => ({
  triggerSelection: vi.fn()
}))
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
}) {
  const readMarkdownTab = vi.fn()
  const readFileTab = vi.fn()
  const setActiveSessionTabId = vi.fn()
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
        setActiveHandle: vi.fn(),
        switchSessionTabRef: { current: null },
        terminalDiagnosticsRef: { current: new MobileTerminalDiagnostics() },
        pendingSelectionRef: { current: null },
        activeSessionTabTypeRef: { current: null },
        activeHandleRef: { current: null },
        client: null,
        sessionTabs: []
      })
    )
  })
  hook.mount()
  return {
    readMarkdownTab,
    readFileTab,
    setActiveSessionTabId,
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

function terminalSwitching(subscribed = true) {
  const tabs: MobileSessionTab[] = [
    { type: 'terminal', id: 'a', title: 'A', terminal: 'pty-a', isActive: false },
    { type: 'terminal', id: 'b', title: 'B', terminal: 'pty-b', isActive: true }
  ]
  const subscribe = vi.fn()
  const unsubscribe = vi.fn()
  const sendRequest = vi.fn(async () => ({ id: 'reply', ok: true as const, result: {} }))
  const activeHandleRef: { current: string | null } = { current: 'pty-a' }
  const hook = hookMount(() => {
    switching = useMobileSessionTabSwitching(
      mountFixture<Parameters<typeof useMobileSessionTabSwitching>[0]>({
        activeSessionTabId: 'a',
        activeHandleRef,
        activeSessionTabTypeRef: { current: 'terminal' },
        pendingSelectionRef: { current: null },
        terminalUnsubsRef: { current: new Map(subscribed ? [['pty-a', vi.fn()]] : []) },
        subscribingHandlesRef: { current: new Set<string>() },
        terminalDiagnosticsRef: { current: new MobileTerminalDiagnostics() },
        visibleTerminalHandlesRef: { current: [] },
        switchSessionTabRef: { current: null },
        setActiveSessionTabId: vi.fn(),
        setActiveHandle: vi.fn(),
        subscribeToTerminal: subscribe,
        unsubscribeTerminal: unsubscribe,
        markdownDocs: new Map(),
        fileDocs: new Map(),
        sessionTabs: tabs,
        client: { sendRequest },
        worktreeId: 'workspace'
      })
    )
  })
  let switching: ReturnType<typeof useMobileSessionTabSwitching>
  hook.mount()
  return {
    tabs,
    subscribe,
    unsubscribe,
    sendRequest,
    activeHandleRef,
    hook,
    select: (tab: MobileSessionTab) => switching.switchSessionTab(tab)
  }
}

it('preserves the locally selected terminal stream when its tab is retapped', () => {
  const h = terminalSwitching()
  try {
    performHookAction(() => h.select(h.tabs[0]))
    expect(h.unsubscribe).not.toHaveBeenCalled()
    expect(h.subscribe).not.toHaveBeenCalled()
    expect(h.sendRequest).not.toHaveBeenCalled()
  } finally {
    h.hook.unmount()
  }
})

it('switches away and back before a render even while the original stream is subscribed', () => {
  const h = terminalSwitching()
  try {
    performHookAction(() => {
      h.select(h.tabs[1])
      h.select(h.tabs[0])
    })
    expect(h.activeHandleRef.current).toBe('pty-a')
    expect(h.subscribe).toHaveBeenCalledWith('pty-b')
    expect(h.subscribe).toHaveBeenCalledWith('pty-a')
    expect(h.sendRequest).toHaveBeenLastCalledWith('session.tabs.activate', {
      worktree: 'id:workspace',
      tabId: 'a',
      notifyClients: false,
      navigation: 'caller',
      intent: 'user'
    })
  } finally {
    h.hook.unmount()
  }
})

it('retries a missing stream and still activates a terminal without a handle', () => {
  const h = terminalSwitching(false)
  try {
    performHookAction(() => h.select(h.tabs[0]))
    expect(h.subscribe).toHaveBeenCalledWith('pty-a')
    performHookAction(() => h.select({ ...h.tabs[0], type: 'terminal', terminal: null }))
    expect(h.activeHandleRef.current).toBeNull()
  } finally {
    h.hook.unmount()
  }
})
