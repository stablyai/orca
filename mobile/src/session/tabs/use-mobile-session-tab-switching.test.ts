import { describe, expect, it, vi } from 'vitest'

vi.mock('../../platform/haptics', () => ({
  triggerSelection: vi.fn()
}))
import type {
  FileDocState,
  MarkdownDocState
} from '../../files/session-documents/session-document-state'
import type { MobileSessionTab } from './mobile-session-tabs'
import { isCachedActiveDocumentRetap } from '../../files/session-documents/mobile-session-active-document-retap'

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
