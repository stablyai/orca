import { useCallback } from 'react'
import { Keyboard, Platform } from 'react-native'
import { useClipboardWriter } from '../platform/clipboard'
import { useBackClaim } from '../navigation/use-back-claim'
import { markdownTabSave } from './mobile-session-write-operations'
import { triggerSuccess, triggerError } from '../platform/haptics'
import type { DirtyMarkdownDraft, MobileSessionTab } from './mobile-session-route-types'
import type { MobileSessionDiffCommentsModel } from './use-mobile-session-diff-comments'

/**
 * What these actions read, which is fourteen of the session model's two hundred and sixty-eight.
 *
 * Declared rather than taking the whole model, so the hook can be rendered on its own: its Back
 * claim is tested directly (ruling 33.2), and a probe that had to build the whole session to reach
 * it would be testing the session. `MobileSessionDiffCommentsModel` satisfies this by
 * construction, so the one caller is unchanged.
 */
export type MobileSessionMarkdownActionsScope = Pick<
  MobileSessionDiffCommentsModel,
  | 'hostId'
  | 'worktreeId'
  | 'router'
  | 'client'
  | 'sessionTabs'
  | 'setMarkdownDocs'
  | 'markdownDocs'
  | 'setDiscardMarkdownTarget'
  | 'discardMarkdownTarget'
  | 'setLeaveDrafts'
  | 'markdownSaveSeqRef'
  | 'markdownSaveInFlightRef'
  | 'showToast'
  | 'readMarkdownTab'
>

export function useMobileSessionMarkdownActions(scope: MobileSessionMarkdownActionsScope) {
  const {
    hostId,
    worktreeId,
    router,
    client,
    sessionTabs,
    setMarkdownDocs,
    markdownDocs,
    setDiscardMarkdownTarget,
    discardMarkdownTarget,
    setLeaveDrafts,
    markdownSaveSeqRef,
    markdownSaveInFlightRef,
    showToast,
    readMarkdownTab
  } = scope
  const clipboard = useClipboardWriter()
  const updateMarkdownLocalContent = useCallback((tabId: string, content: string) => {
    setMarkdownDocs((prev) => {
      const current = prev.get(tabId)
      if (current?.status !== 'ready') {
        return prev
      }
      const next = new Map(prev)
      next.set(tabId, {
        ...current,
        localContent: content,
        isDirty: content !== current.content,
        saveError: undefined
      })
      return next
    })
  }, [])

  const copyMarkdownLocalContent = useCallback(
    async (tabId: string) => {
      const current = markdownDocs.get(tabId)
      if (current?.status !== 'ready') {
        return
      }
      // Caught here because the only caller is `void copyMarkdownLocalContent(...)`: the seam
      // rejects when the pasteboard refused the text, and an uncaught rejection would leave
      // "Copied" as the last word on a copy that did not happen.
      try {
        await clipboard.writeText(current.localContent)
      } catch {
        triggerError()
        showToast("Couldn't copy", 1500)
        return
      }
      triggerSuccess()
      showToast('Copied')
    },
    [clipboard, markdownDocs, showToast]
  )

  const getDirtyMarkdownDrafts = useCallback(() => {
    const drafts: DirtyMarkdownDraft[] = []
    for (const [tabId, doc] of markdownDocs) {
      if (doc.status === 'ready' && doc.isDirty) {
        const tab = sessionTabs.find((candidate) => candidate.id === tabId)
        drafts.push({ tabId, title: tab?.title || 'Markdown', content: doc.localContent })
      }
    }
    return drafts
  }, [markdownDocs, sessionTabs])

  const leaveSession = useCallback(() => {
    if (router.canGoBack()) {
      router.back()
      return
    }
    // Why: Android back can fire at the root route; replace avoids React Navigation's dev-only GO_BACK warning.
    router.replace(`/h/${hostId}`)
  }, [hostId, router])

  const requestLeaveSession = useCallback(() => {
    const dirtyDrafts = getDirtyMarkdownDrafts()
    if (dirtyDrafts.length === 0) {
      leaveSession()
      return
    }
    Keyboard.dismiss()
    setLeaveDrafts(dirtyDrafts)
  }, [getDirtyMarkdownDrafts, leaveSession])

  // Native holds the key always: `leaveSession` replaces to the host at the root, where an
  // unclaimed press would exit the app. On the page an unclaimed press is the shell's own pop,
  // which is already "leave", so the claim is held only while there is a draft to ask about.
  const hasDirtyDraft = getDirtyMarkdownDrafts().length > 0
  useBackClaim(
    Platform.OS === 'web' && !hasDirtyDraft
      ? null
      : () => {
          requestLeaveSession()
          return true
        }
  )

  const discardMarkdownLocalContent = useCallback(
    (tab: Extract<MobileSessionTab, { type: 'markdown' }>) => {
      const current = markdownDocs.get(tab.id)
      if (current?.status !== 'ready') {
        return
      }
      if (!current.isDirty) {
        void readMarkdownTab(tab)
        return
      }
      Keyboard.dismiss()
      setDiscardMarkdownTarget(tab)
    },
    [markdownDocs, readMarkdownTab]
  )

  const confirmDiscardMarkdown = useCallback(() => {
    const target = discardMarkdownTarget
    setDiscardMarkdownTarget(null)
    if (target) {
      void readMarkdownTab(target)
    }
  }, [discardMarkdownTarget, readMarkdownTab])

  const saveMarkdownTab = useCallback(
    async (tab: Extract<MobileSessionTab, { type: 'markdown' }>) => {
      if (!client) {
        return
      }
      const current = markdownDocs.get(tab.id)
      if (current?.status !== 'ready' || current.saving || !current.editable) {
        return
      }
      if (markdownSaveInFlightRef.current.has(tab.id)) {
        return
      }
      markdownSaveInFlightRef.current.add(tab.id)
      const saveSeq = (markdownSaveSeqRef.current.get(tab.id) ?? 0) + 1
      markdownSaveSeqRef.current.set(tab.id, saveSeq)
      setMarkdownDocs((prev) => {
        const existing = prev.get(tab.id)
        if (existing?.status !== 'ready') {
          return prev
        }
        return new Map(prev).set(tab.id, { ...existing, saving: true, saveError: undefined })
      })
      try {
        const response = await markdownTabSave.request(client, {
          worktree: `id:${worktreeId}`,
          tabId: tab.id,
          baseVersion: current.baseVersion,
          content: current.localContent
        })
        const result = markdownTabSave.interpret(response)
        if (markdownSaveSeqRef.current.get(tab.id) !== saveSeq) {
          return
        }
        setMarkdownDocs((prev) =>
          new Map(prev).set(tab.id, {
            status: 'ready',
            content: result.content,
            localContent: result.content,
            baseVersion: result.version,
            isDirty: false,
            editable: true
          })
        )
        markdownSaveSeqRef.current.delete(tab.id)
        triggerSuccess()
        showToast('Saved')
      } catch (error) {
        triggerError()
        const message = error instanceof Error ? error.message : 'Save failed'
        if (markdownSaveSeqRef.current.get(tab.id) !== saveSeq) {
          return
        }
        setMarkdownDocs((prev) => {
          const existing = prev.get(tab.id)
          if (existing?.status !== 'ready') {
            return prev
          }
          return new Map(prev).set(tab.id, {
            ...existing,
            saving: false,
            saveError: message || 'Save failed'
          })
        })
      } finally {
        markdownSaveInFlightRef.current.delete(tab.id)
      }
    },
    [client, markdownDocs, showToast, worktreeId]
  )
  return {
    updateMarkdownLocalContent,
    copyMarkdownLocalContent,
    getDirtyMarkdownDrafts,
    leaveSession,
    requestLeaveSession,
    discardMarkdownLocalContent,
    confirmDiscardMarkdown,
    saveMarkdownTab
  }
}

export type MobileSessionMarkdownActionsModel = MobileSessionDiffCommentsModel &
  ReturnType<typeof useMobileSessionMarkdownActions>
