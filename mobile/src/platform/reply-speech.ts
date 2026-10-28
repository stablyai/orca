import { useMemo } from 'react'
import { speakReply, stopSpeaking } from '../speech/reply-speaker'

export type ReplySpeech = {
  /** False where nothing can speak, so the Read button is not drawn at all. */
  canSpeak: boolean
  speak: (id: string, markdown: string) => void
  stop: () => void
}

// Native: the shell's own TTS directly; the `.web` sibling goes through the bridge.
export function useReplySpeech(): ReplySpeech {
  return useMemo(
    () => ({
      canSpeak: true,
      speak: (id, markdown) => speakReply(id, markdown, 'interrupt'),
      stop: () => stopSpeaking('chat asked to stop')
    }),
    []
  )
}
