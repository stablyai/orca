import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileSessionMarkdownDocLifecycle } from './mobile-session-markdown-doc-lifecycle'
import type { MarkdownDocState, MobileSessionTab } from './mobile-session-route-types'
import { useMobileSessionCloseActions } from './use-mobile-session-close-actions'
import type { MobileSessionContentCreateActionsModel } from './use-mobile-session-content-create-actions'

let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
})

function setup(clearMarkdownDraft: () => Promise<void>) {
  const tab: MobileSessionTab = {
    id: 'note',
    type: 'markdown',
    title: 'Note',
    filePath: '/workspace/note.md',
    relativePath: 'note.md'
  }
  const sibling = { ...tab, id: 'sibling' }
  const ref = <T>(current: T) => ({ current })
  const scope = {
    worktreeId: 'workspace',
    sessionTabOperations: { close: vi.fn().mockResolvedValue({ outcome: 'closed' }) },
    sessionTabsRef: ref([tab, sibling]),
    setSessionTabs: vi.fn(),
    reconcileBufferedDraftsRef: ref(vi.fn()),
    markdownDocLifecycleRef: ref(new MobileSessionMarkdownDocLifecycle()),
    markdownDocsRef: ref(new Map<string, MarkdownDocState>([['note', { status: 'loading' }]])),
    setMarkdownDocs: vi.fn(),
    markdownSaveSeqRef: ref(new Map([['note', 1]])),
    markdownSaveInFlightRef: ref(new Set(['note'])),
    closedTabTombstonesRef: ref(new Map()),
    activeSessionTabIdRef: ref('sibling'),
    clearMarkdownDraft
  }
  let actions!: ReturnType<typeof useMobileSessionCloseActions>
  function Harness() {
    actions = useMobileSessionCloseActions(
      scope as unknown as MobileSessionContentCreateActionsModel
    )
    return null
  }
  act(() => {
    renderer = create(createElement(Harness))
  })
  return { scope, actions, tab, sibling }
}

describe('markdown close draft cleanup', () => {
  it('cannot replace a newer session snapshot while draft persistence is pending', async () => {
    let finishCleanup!: () => void
    const clear = vi.fn(() => new Promise<void>((resolve) => (finishCleanup = resolve)))
    const { scope, actions, tab, sibling } = setup(clear)
    const closing = actions.handleCloseSessionTab(tab)
    await Promise.resolve()
    expect(clear).toHaveBeenCalledWith(tab)

    const newest = [sibling, { ...tab, id: 'new-note' }]
    scope.sessionTabsRef.current = newest
    scope.setSessionTabs.mockClear()
    finishCleanup()
    await closing

    expect(scope.sessionTabsRef.current).toEqual(newest)
    expect(scope.setSessionTabs).not.toHaveBeenCalled()
    expect(scope.markdownDocsRef.current.has(tab.id)).toBe(false)
    expect(scope.markdownSaveInFlightRef.current.has(tab.id)).toBe(false)
    expect(scope.closedTabTombstonesRef.current.has(tab.id)).toBe(true)
  })

  it('finishes the acknowledged close even if draft deletion fails', async () => {
    const { scope, actions, tab, sibling } = setup(() => Promise.reject(new Error('storage')))
    await actions.handleCloseSessionTab(tab)
    expect(scope.sessionTabsRef.current).toEqual([sibling])
    expect(scope.setSessionTabs).toHaveBeenCalledWith([sibling])
    expect(scope.markdownSaveSeqRef.current.has(tab.id)).toBe(false)
  })
})
