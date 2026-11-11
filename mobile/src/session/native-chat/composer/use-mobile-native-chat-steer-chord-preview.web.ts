import { useEffect, useState } from 'react'
import { hostOs } from '../../../platform/host-os'
import { createNativeChatSteerChordPreviewHook } from '../../../../../src/shared/native-chat/input/use-native-chat-steer-chord-preview'
import type { MobileNativeChatSteerChordPreviewInput } from './use-mobile-native-chat-steer-chord-preview'

const useNativeChatSteerChordPreview = createNativeChatSteerChordPreviewHook({
  useEffect,
  useState
})

/** Desktop's held Cmd/Ctrl cue on a hardware keyboard: Send shows what Cmd/Ctrl+Enter would do. */
export function useMobileNativeChatSteerChordPreview({
  fieldRef,
  hasDraft,
  followUp,
  deliversMessage,
  steerHead,
  pickerOpen,
  sendAlternate
}: MobileNativeChatSteerChordPreviewInput) {
  // The keyboard submit's own reading: the other way only where the follow-up offers one.
  const alternateSend =
    deliversMessage && followUp?.offersChoice
      ? followUp.action === 'queue'
        ? ('steer' as const)
        : ('queue' as const)
      : undefined
  const alternateSteers = followUp?.action === 'queue' && followUp.offersChoice
  const chord = useNativeChatSteerChordPreview(
    fieldRef,
    {
      alternateSend,
      hasDraft,
      chordSteersHead: steerHead?.steers(alternateSteers) === true
    },
    steerHead && (() => steerHead.run(alternateSteers)),
    sendAlternate,
    pickerOpen,
    // The field's own submit chord: Cmd on an iPhone or iPad keyboard, Ctrl elsewhere.
    hostOs() === 'ios' ? 'Meta' : 'Control'
  )
  const lit = chord.preview === 'steer-queued'
  const light = steerHead?.light
  useEffect(() => {
    if (!light || !lit) {
      return
    }
    light(true)
    return () => light(false)
  }, [light, lit])
  return chord
}
