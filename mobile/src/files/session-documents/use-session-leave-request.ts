import { useCallback, useEffect, useRef } from 'react'
import { Keyboard } from 'react-native'
import type { DirtyMarkdownDraft } from './session-document-state'

/** A leave that goes its own way (the menu's Delete) once drafts are settled; `valid` rechecks its origin. */
export type LeaveHandoff = { run: () => void; valid: () => boolean }

export type LeaveTicket = { readonly id: number }

type LeaveRequest = {
  id: number
  drafts: readonly DirtyMarkdownDraft[]
  /** The exact draft revisions the sheet offered to copy or discard. */
  revisions: string
  handoff: LeaveHandoff | null
  settling: boolean
}

/** One revocable leave behind the unsaved-drafts sheet. Copy or Discard settles only the request the
 *  sheet showed, and only while the drafts are still those revisions; an edit, a newer leave, closing
 *  the sheet, or leaving the screen revokes it, and a second press on it does nothing. */
export function useSessionLeaveRequest(args: {
  readDrafts: () => DirtyMarkdownDraft[]
  /** The dirty drafts' tab ids and revisions, as one comparable value. */
  readRevisions: () => string
  setLeaveDrafts: (drafts: DirtyMarkdownDraft[] | null) => void
  dropDrafts: (drafts: readonly DirtyMarkdownDraft[]) => void
  leaveSession: () => void
}) {
  const { setLeaveDrafts } = args
  const requestRef = useRef<LeaveRequest | null>(null)
  const issuedRef = useRef(0)
  // The latest readers, so a reply that lands later checks the drafts as they are then.
  const latestRef = useRef(args)
  useEffect(() => {
    latestRef.current = args
    const request = requestRef.current
    if (request && args.readRevisions() !== request.revisions) {
      requestRef.current = null
    }
  })
  useEffect(
    () => () => {
      requestRef.current = null
    },
    []
  )

  const requestLeave = useCallback(
    (handoff: LeaveHandoff | null = null) => {
      requestRef.current = null
      const { readDrafts, readRevisions, leaveSession } = latestRef.current
      const drafts = readDrafts()
      if (drafts.length === 0) {
        if (handoff) {
          handoff.run()
        } else {
          leaveSession()
        }
        return
      }
      Keyboard.dismiss()
      issuedRef.current += 1
      requestRef.current = {
        id: issuedRef.current,
        drafts,
        revisions: readRevisions(),
        handoff,
        settling: false
      }
      setLeaveDrafts(drafts)
    },
    [setLeaveDrafts]
  )

  /** The sheet's Copy or Discard press: the request it settles, or null if it is gone or already settling. */
  const beginLeave = useCallback((): LeaveTicket | null => {
    const request = requestRef.current
    if (!request || request.settling) {
      return null
    }
    request.settling = true
    return { id: request.id }
  }, [])

  const finishLeave = useCallback(
    (ticket: LeaveTicket) => {
      const request = requestRef.current
      if (!request || request.id !== ticket.id) {
        return
      }
      requestRef.current = null
      const { readRevisions, dropDrafts, leaveSession } = latestRef.current
      if (readRevisions() !== request.revisions || request.handoff?.valid() === false) {
        return
      }
      dropDrafts(request.drafts)
      setLeaveDrafts(null)
      if (request.handoff) {
        request.handoff.run()
      } else {
        leaveSession()
      }
    },
    [setLeaveDrafts]
  )

  const abandonLeave = useCallback((ticket: LeaveTicket) => {
    if (requestRef.current?.id === ticket.id) {
      requestRef.current = null
    }
  }, [])

  /** The sheet closing: a request no press is settling is revoked. */
  const closeLeave = useCallback(() => {
    if (requestRef.current && !requestRef.current.settling) {
      requestRef.current = null
    }
  }, [])

  return { requestLeave, beginLeave, finishLeave, abandonLeave, closeLeave }
}
