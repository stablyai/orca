import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { MarkdownDocState, MobileSessionTab } from './mobile-session-route-types'
import type { MobileSessionDiffCommentsModel } from './use-mobile-session-diff-comments'
import { useMobileSessionMarkdownActions } from './use-mobile-session-markdown-actions'

vi.mock('react-native', () => ({
  BackHandler: { addEventListener: () => ({ remove() {} }) },
  Keyboard: { dismiss() {} }
}))

describe('markdown actions with pending draft persistence', () => {
  it.each(['save', 'discard'] as const)(
    '%s applies the document transition without waiting for draft deletion',
    async (action) => {
      const tab: Extract<MobileSessionTab, { type: 'markdown' }> = {
        id: 'note',
        type: 'markdown',
        title: 'Note',
        filePath: '/workspace/note.md',
        relativePath: 'note.md'
      }
      let docs = new Map<string, MarkdownDocState>([
        [
          tab.id,
          {
            status: 'ready',
            content: 'old',
            localContent: 'edited',
            baseVersion: 'v1',
            isDirty: true,
            editable: true
          }
        ]
      ])
      let finishCleanup!: () => void
      const clearMarkdownDraft = vi.fn(
        () => new Promise<void>((resolve) => (finishCleanup = resolve))
      )
      const readMarkdownTab = vi.fn()
      const scope = {
        hostId: 'host',
        worktreeId: 'workspace',
        sessionTabs: [tab],
        markdownDocs: docs,
        setMarkdownDocs: vi.fn((update: (current: typeof docs) => typeof docs) => {
          docs = update(docs)
        }),
        markdownSaveSeqRef: { current: new Map<string, number>() },
        markdownSaveInFlightRef: { current: new Set<string>() },
        sessionMarkdownOperations: {
          saveTab: vi.fn().mockResolvedValue({ content: 'edited', baseVersion: 'v2' })
        },
        clearMarkdownDraft,
        readMarkdownTab,
        setDiscardMarkdownTarget: vi.fn(),
        discardMarkdownTarget: tab,
        showToast: vi.fn(),
        triggerSuccess: vi.fn(),
        triggerError: vi.fn()
      }
      let actions!: ReturnType<typeof useMobileSessionMarkdownActions>
      function Harness() {
        actions = useMobileSessionMarkdownActions(
          scope as unknown as MobileSessionDiffCommentsModel
        )
        return null
      }
      let renderer!: ReturnType<typeof create>
      act(() => {
        renderer = create(createElement(Harness))
      })
      try {
        let pending: Promise<void> | undefined
        await act(async () => {
          if (action === 'save') {
            pending = actions.saveMarkdownTab(tab)
          } else {
            actions.confirmDiscardMarkdown()
          }
          await Promise.resolve()
        })
        expect(clearMarkdownDraft).toHaveBeenCalledWith(tab)
        const docBeforeCleanup = docs.get(tab.id)
        const readsBeforeCleanup = readMarkdownTab.mock.calls.length

        // Closing the tab while storage is pending must not resurrect the saved document.
        docs.clear()
        scope.markdownSaveSeqRef.current.clear()
        await act(async () => {
          finishCleanup()
          await pending
        })
        expect(docs.size).toBe(0)
        if (action === 'save') {
          expect(docBeforeCleanup).toMatchObject({ content: 'edited', isDirty: false })
        } else {
          expect(readsBeforeCleanup).toBe(1)
          expect(readMarkdownTab).toHaveBeenCalledWith(tab)
        }
      } finally {
        act(() => renderer.unmount())
      }
    }
  )
})
