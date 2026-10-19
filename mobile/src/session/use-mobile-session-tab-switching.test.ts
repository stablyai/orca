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
