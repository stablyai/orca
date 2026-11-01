import { useContext, useEffect, useLayoutEffect, useRef } from 'react'
import type { TextInputSelectionChangeEvent } from 'react-native'
import {
  insertDictationText,
  readMobileDictationAnchor,
  splitDraftForDictation,
  type MobileDictationAnchor
} from '../../../dictation/mobile-dictation-text-insertion'
import {
  mobileNativeChatDraftDestination,
  registerMobileNativeChatTextDestination
} from './mobile-native-chat-draft-inputs'
import { MobileNativeChatDictationPreviewContext } from './mobile-native-chat-dictation-preview-context'
import { setMobileNativeChatDraftText } from './mobile-native-chat-draft-store'

// The composer's side of dictation: where its words land, and the grey words heard so far.
export function useMobileNativeChatComposerDictation({
  draftScopeKey,
  value,
  insertDictation,
  placeCaret
}: {
  draftScopeKey: string | null | undefined
  value: string
  insertDictation: ((insert: (draft: string) => string) => boolean | void) | undefined
  placeCaret: (at: number) => void
}) {
  // Dictation lands on the selection the field had when it started, so taps elsewhere while talking don't move it.
  const selectionRef = useRef<MobileDictationAnchor | null>(null)
  const shownScopeRef = useRef(draftScopeKey)
  useLayoutEffect(() => {
    shownScopeRef.current = draftScopeKey
    // Another chat's draft: its selection is unknown until the field reports one.
    selectionRef.current = null
  }, [draftScopeKey])
  useEffect(() => {
    if (!draftScopeKey) {
      return
    }
    const destination = mobileNativeChatDraftDestination(draftScopeKey)
    const write =
      insertDictation ??
      ((insert: (draft: string) => string) => setMobileNativeChatDraftText(destination, insert))
    return registerMobileNativeChatTextDestination(draftScopeKey, () => {
      const anchor = selectionRef.current
      return {
        scope: draftScopeKey,
        anchor,
        insert: (text) => {
          // A retired tab's late dictation must not revive its draft.
          if (!destination.active) {
            return false
          }
          const landed = { caret: 0, text: '' }
          const inserted = write((draft) => {
            const next = insertDictationText(draft, text, anchor)
            landed.caret = next.caret
            landed.text = next.text
            return next.text
          })
          // A reused composer may show another chat by now; only its own draft's caret moves.
          if (inserted !== false && shownScopeRef.current === draftScopeKey) {
            selectionRef.current = { start: landed.caret, end: landed.caret, text: landed.text }
            placeCaret(landed.caret)
          }
          return inserted
        }
      }
    })
  }, [draftScopeKey, insertDictation, placeCaret])
  const heard = useContext(MobileNativeChatDictationPreviewContext)
  const preview =
    heard && heard.scope === (draftScopeKey ?? null)
      ? { ...splitDraftForDictation(value, heard.text, heard.anchor), text: heard.text }
      : null
  return {
    preview,
    readSelection: (event: TextInputSelectionChangeEvent) => {
      selectionRef.current = readMobileDictationAnchor(event, value)
    }
  }
}
