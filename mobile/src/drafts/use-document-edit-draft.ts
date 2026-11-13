import { useEffect, useMemo, useRef, useState } from 'react'
import { hashMarkdownContent } from '../../../src/shared/mobile-markdown-document'
import {
  holdDocumentEditDraftOffer,
  loadDocumentEditDraft,
  saveDocumentEditDraft,
  type DocumentEditDraft
} from './document-edit-draft-rows'

export type DocumentEditDraftOffer = {
  content: string
  savedAt: number
  // False once the host's version differs from the one the edits were made against: they can only be copied then.
  baseMatches: boolean
}

type DraftState = {
  key: string | null
  phase: 'pending' | 'ready'
  // Edits saved before the page was killed, waiting for Restore or Discard; the row is left alone until then.
  offer: DocumentEditDraft | null
}

/**
 * Keeps an editable document's unsaved edits in its draft row, and offers back the ones a killed page left.
 * `base` is the host's content, or null while it is loading. A document that can't be edited only offers a copy.
 */
export function useDocumentEditDraft({
  draftKey,
  base,
  editable,
  live,
  onRestore
}: {
  draftKey: string | null
  base: string | null
  editable: boolean
  live: string
  onRestore: (content: string) => void
}) {
  const [state, setState] = useState<DraftState>({ key: draftKey, phase: 'pending', offer: null })
  // The reader is reused across tabs, so a new document starts over.
  if (state.key !== draftKey) {
    setState({ key: draftKey, phase: 'pending', offer: null })
  } else if (state.offer && state.offer.content === base) {
    // Saved by hand without Restore: the host now has these edits.
    setState({ ...state, offer: null })
  }
  const baseHash = useMemo(() => (base === null ? null : hashMarkdownContent(base)), [base])
  const latest = useRef({ base, live })
  useEffect(() => {
    latest.current = { base, live }
  })

  const canDecide = draftKey !== null && base !== null && state.phase === 'pending'
  // Rerun on typing too, so a read the store dropped is retried.
  useEffect(() => {
    if (!canDecide || !draftKey) {
      return
    }
    let active = true
    void loadDocumentEditDraft(draftKey).then((stored) => {
      if (!active || stored === undefined) {
        return
      }
      const { base: hostContent, live: shown } = latest.current
      let offer = stored && stored.content !== shown ? stored : null
      if (offer && offer.content === hostContent) {
        // The edits reached the host before the page went away.
        saveDocumentEditDraft(draftKey, null)
        offer = null
      }
      holdDocumentEditDraftOffer(draftKey, offer !== null)
      setState((current) =>
        current.key === draftKey && current.phase === 'pending'
          ? { key: draftKey, phase: 'ready', offer }
          : current
      )
    })
    return () => {
      active = false
    }
  }, [canDecide, draftKey, live])

  useEffect(() => {
    if (state.phase !== 'ready' || state.offer || !editable || !draftKey || baseHash === null) {
      return
    }
    holdDocumentEditDraftOffer(draftKey, false)
    saveDocumentEditDraft(
      draftKey,
      live === base ? null : { content: live, baseHash, savedAt: Date.now() }
    )
  }, [base, baseHash, draftKey, editable, live, state])

  const offer: DocumentEditDraftOffer | null =
    state.key === draftKey && state.offer && base !== null
      ? {
          content: state.offer.content,
          savedAt: state.offer.savedAt,
          baseMatches: editable && state.offer.baseHash === baseHash
        }
      : null

  return {
    offer,
    restore: () => {
      if (draftKey && offer?.baseMatches) {
        holdDocumentEditDraftOffer(draftKey, false)
        onRestore(offer.content)
        setState((current) => ({ ...current, offer: null }))
      }
    },
    discardOffer: () => {
      if (draftKey) {
        holdDocumentEditDraftOffer(draftKey, false)
        saveDocumentEditDraft(draftKey, null)
      }
      setState((current) => ({ ...current, offer: null }))
    }
  }
}
