import { useCallback } from 'react'
import { Keyboard, Platform } from 'react-native'
import { useClipboardWriter } from '../platform/clipboard'
import { translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useBackClaim } from '../navigation/use-back-claim'
import { useSessionLeaveGuard } from './session-leave-guard'
import { markdownTabSave } from './mobile-session-write-operations'
import { triggerSuccess, triggerError } from '../platform/haptics'
import type { DirtyMarkdownDraft, MobileSessionTab } from './mobile-session-route-types'
import type { MobileSessionDiffCommentsModel } from './use-mobile-session-diff-comments'

// Depend on the action’s narrow scope so Back behavior can be tested without constructing the whole session model.
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
  | 'dictationLeaveHold'
>

export function useMobileSessionMarkdownActions(scope: MobileSessionMarkdownActionsScope) {
  const t = useMobileTranslation()
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
    readMarkdownTab,
    dictationLeaveHold: { hold: holdLeaveForDictation, holdsLeave: dictationHoldsLeave }
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
        localRevision: (current.localRevision ?? 0) + 1,
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
      // Contain fire-and-forget clipboard refusal so Copied cannot remain as false success feedback.
      try {
        await clipboard.writeText(current.localContent)
      } catch {
        triggerError()
        showToast(translate('session.useMarkdownActions.copyFailed', "Couldn't copy"), 1500)
        return
      }
      triggerSuccess()
      showToast(translate('common.copied', 'Copied'))
    },
    [clipboard, markdownDocs, showToast]
  )

  const copyMarkdownPath = useCallback(
    async (tab: Extract<MobileSessionTab, { type: 'markdown' }>) => {
      try {
        await clipboard.writeText(tab.relativePath || tab.filePath)
        showToast(translate('session.useMarkdownActions.pathCopied', 'Path copied'))
      } catch {
        triggerError()
        showToast(
          translate('session.useMarkdownActions.copyPathFailed', "Couldn't copy path"),
          1500
        )
      }
    },
    [clipboard, showToast]
  )

  const getDirtyMarkdownDrafts = useCallback(() => {
    const drafts: DirtyMarkdownDraft[] = []
    for (const [tabId, doc] of markdownDocs) {
      if (doc.status === 'ready' && doc.isDirty) {
        const tab = sessionTabs.find((candidate) => candidate.id === tabId)
        drafts.push({
          tabId,
          title: tab?.title || t('session.useMarkdownActions.markdownTitle', 'Markdown'),
          content: doc.localContent
        })
      }
    }
    return drafts
  }, [markdownDocs, sessionTabs, t])

  const leaveSession = useCallback(() => {
    if (router.canGoBack()) {
      router.back()
      return
    }
    // Why: Android back can fire at the root route; replace avoids React Navigation's dev-only GO_BACK warning.
    router.replace(`/h/${hostId}`)
  }, [hostId, router])

  const requestLeaveSession = useCallback(() => {
    if (holdLeaveForDictation()) {
      return
    }
    const dirtyDrafts = getDirtyMarkdownDrafts()
    if (dirtyDrafts.length === 0) {
      leaveSession()
      return
    }
    Keyboard.dismiss()
    setLeaveDrafts(dirtyDrafts)
  }, [getDirtyMarkdownDrafts, holdLeaveForDictation, leaveSession])

  // Native always claims Back to avoid root exit; the web shell already pops, so only dirty drafts and dictation need a claim.
  const hasDirtyDraft = getDirtyMarkdownDrafts().length > 0
  useBackClaim(
    Platform.OS === 'web' && !hasDirtyDraft && !dictationHoldsLeave
      ? null
      : () => {
          requestLeaveSession()
          return true
        }
  )
  useSessionLeaveGuard(dictationHoldsLeave ? holdLeaveForDictation : null)

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
        return new Map(prev).set(tab.id, {
          ...existing,
          localRevision: (existing.localRevision ?? 0) + 1,
          saving: true,
          saveError: undefined
        })
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
        setMarkdownDocs((prev) => {
          const existing = prev.get(tab.id)
          const revision =
            existing?.status === 'ready' ? existing.localRevision : current.localRevision
          return new Map(prev).set(tab.id, {
            localRevision: (revision ?? 0) + 1,
            status: 'ready',
            content: result.content,
            localContent: result.content,
            baseVersion: result.version,
            isDirty: false,
            editable: true
          })
        })
        markdownSaveSeqRef.current.delete(tab.id)
        triggerSuccess()
        showToast(translate('session.useMarkdownActions.saved', 'Saved'))
      } catch (error) {
        triggerError()
        const message =
          error instanceof Error
            ? error.message
            : translate('session.useMarkdownActions.saveFailed', 'Save failed')
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
            localRevision: (existing.localRevision ?? 0) + 1,
            saving: false,
            saveError: message || translate('session.useMarkdownActions.saveFailed', 'Save failed')
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
    copyMarkdownPath,
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
