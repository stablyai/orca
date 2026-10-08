/**
 * A host with no desktop window now publishes Markdown, file and diff tabs and answers
 * markdown.readTab itself. Phones already released read those through the same shapes a desktop
 * host sends, so the host's rows and replies must satisfy every field those readers require.
 */
import { describe, expect, it } from 'vitest'
import {
  projectMobileSessionFileTab,
  projectMobileSessionMarkdownTab
} from '../../../src/shared/mobile-session-editor-tab-projection'
import { hashMarkdownContent } from '../../../src/shared/mobile-markdown-document'
import type { MobileSessionTab } from './mobile-session-route-types'
import { markdownTabDocumentSchema } from './session-read-reply-schema'

const markdownFacts = {
  id: '/work/notes.md',
  filePath: '/work/notes.md',
  relativePath: 'notes.md',
  language: 'markdown',
  mode: 'edit',
  isDirty: false
}

describe('host-published editor tabs against released phone readers', () => {
  it('publishes Markdown rows with every field the released phone route type requires', () => {
    const tab = projectMobileSessionMarkdownTab(
      { tabId: '6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', isActive: true },
      markdownFacts,
      markdownFacts
    )
    // Why typed: assignment fails typecheck if a field the phone reads goes missing or changes type.
    const phoneRow: MobileSessionTab = tab!
    expect(phoneRow).toMatchObject({
      type: 'markdown',
      id: expect.any(String),
      title: 'notes.md',
      filePath: '/work/notes.md',
      relativePath: 'notes.md',
      isDirty: false,
      isActive: true,
      documentVersion: 'file:/work/notes.md'
    })
  })

  it('publishes edit and diff file rows the released phone reads', () => {
    const edit: MobileSessionTab = projectMobileSessionFileTab(
      { tabId: '/work/a.ts', isActive: false },
      {
        ...markdownFacts,
        id: '/work/a.ts',
        filePath: '/work/a.ts',
        relativePath: 'a.ts',
        language: 'typescript'
      }
    )
    const diff: MobileSessionTab = projectMobileSessionFileTab(
      { tabId: 'diff-1', isActive: false },
      {
        id: 'wt::diff::staged::a.ts',
        filePath: '/work/a.ts',
        relativePath: 'a.ts',
        language: 'typescript',
        mode: 'diff',
        isDirty: false,
        diffSource: 'staged'
      }
    )
    expect(edit).toMatchObject({ type: 'file', mode: 'edit', language: 'typescript' })
    expect(diff).toMatchObject({ type: 'file', mode: 'diff', diffSource: 'staged' })
  })

  it('answers markdown.readTab in a shape the phone document reader decodes', () => {
    const content = '# Notes\n'
    const reply = {
      tabId: 'tab-1',
      filePath: '/work/notes.md',
      relativePath: 'notes.md',
      content,
      isDirty: false,
      version: hashMarkdownContent(content),
      source: 'file',
      editable: true
    }
    expect(markdownTabDocumentSchema.parse(reply)).toMatchObject({
      content,
      version: hashMarkdownContent(content),
      isDirty: false,
      editable: true
    })
  })
})
