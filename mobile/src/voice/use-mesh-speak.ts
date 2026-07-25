import { useCallback, useEffect, useRef, useState } from 'react'
import { initialize, playPCMData } from '@orca/expo-two-way-audio'
import { synthesizeViaMesh } from './mesh-voice-turn'

// A2a speak-back: synthesize text via the mesh Kokoro route and play it through
// the phone speaker. The genuine delta over native Orca voice (which is
// STT-only). Used per session for the "Speak replies" toggle and the on-demand
// speaker button. See plans/active/2026-07-20-orca-mobile-voice-pet-canvas.md.
type TimeoutHandle = ReturnType<typeof setTimeout>
export type MeshSpeak = {
  speak: (text: string) => void
  isSpeaking: boolean
}

export function useMeshSpeak(options: { hostEndpoint?: string | null } = {}): MeshSpeak {
  const [isSpeaking, setIsSpeaking] = useState(false)
  const timer = useRef<TimeoutHandle | null>(null)
  const hostEndpoint = options.hostEndpoint

  useEffect(
    () => () => {
      // Why a guard: clearTimeout on undefined is a no-op, but the cleanup
      // also resets the ref so the next mount can't see a stale handle.
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
      }
    },
    []
  )

  const speak = useCallback(
    (text: string) => {
      const clean = text.trim()
      if (!clean) {
        return
      }
      clearTimeout(timer.current ?? undefined)
      setIsSpeaking(true)
      void (async () => {
        try {
          await initialize()
          const pcm16 = await synthesizeViaMesh(clean, hostEndpoint)
          // eslint-disable-next-line no-console
          console.log('[voice] speak pcm16 bytes', pcm16.byteLength)
          playPCMData(pcm16)
          const ms = (pcm16.byteLength / 2 / 16000) * 1000
          timer.current = setTimeout(() => setIsSpeaking(false), Math.min(ms + 500, 60000))
        } catch (err) {
          // eslint-disable-next-line no-console
          console.log('[voice] speak error', String(err))
          setIsSpeaking(false)
        }
      })()
    },
    [hostEndpoint]
  )

  return { speak, isSpeaking }
}
