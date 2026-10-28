import { useEffect } from 'react'
import { useHeadphonesOnly, useLanguageVoices, useLinkReading } from './reading-preferences'
import {
  nextMessage,
  pauseReading,
  previousMessage,
  repeatLast,
  resumeReading,
  setAutoReadNeedsHeadphones,
  stopSpeaking
} from './reply-speaker'
import { setLanguageVoices } from './language-segments'
import { setLinkReading } from './speech-text'
import { voiceNativeModule, type ReaderControl } from './voice-native-module'

function handleControl(action: ReaderControl): void {
  switch (action) {
    case 'pause':
      pauseReading('pause button')
      return
    case 'play':
      resumeReading('play button')
      return
    case 'next':
      nextMessage('next button')
      return
    case 'previous':
      previousMessage('previous button')
      return
    case 'repeat':
      repeatLast('repeat button')
      return
    case 'stop':
      stopSpeaking('stop button')
  }
}

/** Mounted once, with the reader overlay, so notification and headset buttons work anywhere. */
export function useReaderControls(): void {
  const links = useLinkReading().value
  const headphonesOnly = useHeadphonesOnly().value
  const languageVoices = useLanguageVoices().value
  useEffect(() => setLinkReading(links), [links])
  useEffect(() => setAutoReadNeedsHeadphones(headphonesOnly === 'on'), [headphonesOnly])
  useEffect(() => setLanguageVoices(languageVoices === 'on'), [languageVoices])
  useEffect(() => {
    const subscription = voiceNativeModule()?.addListener('onReaderControl', ({ action }) =>
      handleControl(action)
    )
    return () => subscription?.remove()
  }, [])
}
