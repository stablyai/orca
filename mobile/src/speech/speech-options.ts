import { useCallback, useEffect, useRef, useState } from 'react'
import type { LinkReading, TableReading } from '../storage/speech-preferences'
import { readerWords } from './reader-words'
import { speakSample } from './reply-speaker'
import { setLinkReading, setTableReading } from './speech-text'
import { voiceNativeModule, type NativeVoiceList, type SpeechOptions } from './voice-native-module'

// Why: a few taps on the speed buttons read one sample at the final speed, not one per tap.
const SAMPLE_DELAY_MS = 600

export function speakVoiceSample(): void {
  speakSample(readerWords().sample)
}

// Set here too: the reader learns of the new choice only after the settings screen re-renders.
export function speakLinkSample(mode: LinkReading): void {
  setLinkReading(mode)
  speakSample(readerWords().linkSample)
}

export function speakTableSample(mode: TableReading): void {
  setTableReading(mode)
  speakSample(readerWords().tableSample)
}

/** Kept by the native module so the first reading after a restart already uses them. */
export function useSpeechOptions(): {
  available: boolean
  options: SpeechOptions
  /** The phone's own rate, 1 = normal: what "Phone setting" means and where steps start. */
  phoneRate: number
  /** Undefined while loading, null when the engine did not start. */
  voices: NativeVoiceList | null | undefined
  setOptions: (next: SpeechOptions) => void
  openPhoneSettings: () => void
} {
  const native = voiceNativeModule()
  const [stored] = useState(() => native?.getSpeechOptions() ?? null)
  const [options, setOptionsState] = useState<SpeechOptions>({
    rate: stored?.rate ?? null,
    voice: stored?.voice ?? null
  })
  const [voices, setVoices] = useState<NativeVoiceList | null | undefined>(undefined)
  const sampleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let live = true
    void native
      ?.getVoices()
      .catch(() => null)
      .then((list) => {
        if (live) {
          setVoices(list)
        }
      })
    return () => {
      live = false
      if (sampleTimer.current) {
        clearTimeout(sampleTimer.current)
      }
    }
  }, [native])

  const setOptions = useCallback(
    (next: SpeechOptions) => {
      native?.setSpeechOptions(next.rate, next.voice)
      setOptionsState(next)
      if (sampleTimer.current) {
        clearTimeout(sampleTimer.current)
      }
      sampleTimer.current = setTimeout(speakVoiceSample, SAMPLE_DELAY_MS)
    },
    [native]
  )

  const openPhoneSettings = useCallback(() => {
    native?.openTtsSettings()
  }, [native])

  return {
    available: native !== null,
    options,
    phoneRate: stored?.phoneRate ?? 1,
    voices,
    setOptions,
    openPhoneSettings
  }
}
