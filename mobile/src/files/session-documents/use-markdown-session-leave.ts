import { useCallback, useRef } from 'react'
import { Keyboard } from 'react-native'
import type { HostStackHostRoute } from '../../navigation/host-stack-navigation'
import { returnToHostSessionList } from '../../navigation/session-list-back'
import { dropDocumentEditDraft, markdownTabDraftKey } from '../../drafts/document-edit-draft-rows'
import type { WorkspaceDraftScope } from '../../drafts/durable-draft-rows'
import { triggerEdgeBump } from '../../platform/haptics/haptics'
import type { DirtyMarkdownDraft } from './session-document-state'

type LeaveRouter = {
  back: () => void
  canGoBack: () => boolean
  replace: (href: `/h/${string}`) => void
  dismissTo: (href: HostStackHostRoute) => void
}

// One step back, or the host session list when a long-press asked for it.
export function useMarkdownSessionLeave(args: {
  hostId: string
  router: LeaveRouter
  standalone: boolean
  draftScope: WorkspaceDraftScope
  holdLeaveForDictation: () => boolean
  getDirtyMarkdownDrafts: () => DirtyMarkdownDraft[]
  setLeaveDrafts: (drafts: DirtyMarkdownDraft[]) => void
}): {
  leaveSession: () => void
  leaveSessionDroppingDrafts: (drafts: readonly DirtyMarkdownDraft[]) => void
  requestLeaveSession: () => void
  requestLeaveToSessionList: () => void
} {
  const {
    hostId,
    router,
    standalone,
    draftScope,
    holdLeaveForDictation,
    getDirtyMarkdownDrafts,
    setLeaveDrafts
  } = args
  const leaveDestination = useRef<'step' | 'list'>('step')
  const leaveSession = useCallback(() => {
    if (leaveDestination.current === 'list') {
      leaveDestination.current = 'step'
      returnToHostSessionList(router, hostId)
      return
    }
    // A standalone session has no list beneath; the page's Back hands the exit to the shell.
    if (router.canGoBack() || standalone) {
      router.back()
      return
    }
    // Why: Android back can fire at the root route; replace avoids React Navigation's dev-only GO_BACK warning.
    router.replace(`/h/${hostId}`)
  }, [hostId, router, standalone])

  // The sheet's Copy and Discard both settle the phone's drafts, so none is offered back next time.
  const leaveSessionDroppingDrafts = useCallback(
    (drafts: readonly DirtyMarkdownDraft[]) => {
      for (const draft of drafts) {
        dropDocumentEditDraft(markdownTabDraftKey(draftScope, draft.tabId))
      }
      leaveSession()
    },
    [draftScope, leaveSession]
  )

  const requestLeave = useCallback(
    (destination: 'step' | 'list') => {
      leaveDestination.current = destination
      if (holdLeaveForDictation()) {
        leaveDestination.current = 'step'
        return
      }
      const dirtyDrafts = getDirtyMarkdownDrafts()
      if (dirtyDrafts.length === 0) {
        leaveSession()
        return
      }
      Keyboard.dismiss()
      setLeaveDrafts(dirtyDrafts)
    },
    [getDirtyMarkdownDrafts, holdLeaveForDictation, leaveSession, setLeaveDrafts]
  )
  const requestLeaveSession = useCallback(() => requestLeave('step'), [requestLeave])
  const requestLeaveToSessionList = useCallback(() => {
    triggerEdgeBump()
    requestLeave('list')
  }, [requestLeave])

  return {
    leaveSession,
    leaveSessionDroppingDrafts,
    requestLeaveSession,
    requestLeaveToSessionList
  }
}
