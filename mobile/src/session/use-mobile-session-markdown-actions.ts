import { useEffect, useCallback } from 'react'
import { BackHandler, Keyboard } from 'react-native'
import type { DirtyMarkdownDraft, MobileSessionTab } from './mobile-session-route-types'
import type { MobileSessionDiffCommentsModel } from './use-mobile-session-diff-comments'
import { mobileMarkdownSaveErrorCopy } from './mobile-markdown-save-error-copy'

export function useMobileSessionMarkdownActions(scope: MobileSessionDiffCommentsModel) {
  const {
    hostId,
    worktreeId,
    router,
    sessionTabs,
    setMarkdownDocs,
    markdownDocs,
    setDiscardMarkdownTarget,
    discardMarkdownTarget,
    setLeaveDrafts,
    markdownSaveSeqRef,
    markdownSaveInFlightRef,
    showToast,
    readMarkdownTab,
    copyTextToDevice,
    sessionMarkdownOperations,
    clearMarkdownDraft,
    markMarkdownDraftEdited,
    triggerError,
    triggerSuccess
  } = scope
  const updateMarkdownLocalContent = useCallback(
    (tabId: string, content: string) => {
      markMarkdownDraftEdited(tabId)
      setMarkdownDocs((previous) => {
        const current = previous.get(tabId)
        if (current?.status !== 'ready') {
          return previous
        }
        return new Map(previous).set(tabId, {
          ...current,
          localContent: content,
          isDirty: content !== current.content,
          saveError: undefined
        })
      })
    },
    [markMarkdownDraftEdited]
  )

  const copyMarkdownLocalContent = useCallback(
    async (tabId: string) => {
      const current = markdownDocs.get(tabId)
      if (current?.status !== 'ready') {
        return
      }
      await copyTextToDevice(current.localContent)
      triggerSuccess()
      showToast('Copied')
    },
    [copyTextToDevice, markdownDocs, showToast, triggerSuccess]
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

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      requestLeaveSession()
      return true
    })
    return () => subscription.remove()
  }, [requestLeaveSession])

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
      void clearMarkdownDraft(target).catch(() => {})
      void readMarkdownTab(target)
    }
  }, [clearMarkdownDraft, discardMarkdownTarget, readMarkdownTab])

  const saveMarkdownTab = useCallback(
    async (tab: Extract<MobileSessionTab, { type: 'markdown' }>) => {
      if (!sessionMarkdownOperations) {
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
        const result = await sessionMarkdownOperations.saveTab({
          workspaceId: worktreeId,
          tabId: tab.id,
          relativePath: tab.relativePath,
          baseVersion: current.baseVersion,
          content: current.localContent
        })
        if (markdownSaveSeqRef.current.get(tab.id) !== saveSeq) {
          return
        }
        // Draft persistence must not delay an already acknowledged document transition.
        void clearMarkdownDraft(tab).catch(() => {})
        setMarkdownDocs((prev) =>
          new Map(prev).set(tab.id, {
            status: 'ready',
            content: result.content,
            localContent: result.content,
            baseVersion: result.baseVersion,
            isDirty: false,
            editable: true
          })
        )
        markdownSaveSeqRef.current.delete(tab.id)
        triggerSuccess()
        showToast('Saved')
      } catch (error) {
        triggerError()
        const message = mobileMarkdownSaveErrorCopy(error)
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
            saveError: message
          })
        })
      } finally {
        markdownSaveInFlightRef.current.delete(tab.id)
      }
    },
    [clearMarkdownDraft, markdownDocs, sessionMarkdownOperations, showToast, worktreeId]
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
