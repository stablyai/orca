import { useEffect, useMemo } from 'react'
import type { BridgeNativeVerb } from '../mobile-web-shell/bridge/bridge-native-verbs'
import type { BRIDGE_STORE_VERB } from '../mobile-web-shell/bridge/bridge-store-verb'
import { useMediaHandleRegistry } from '../mobile-web-shell/use-media-handle-registry'
import { createNativeAudioCapture } from './native-audio'
import { NATIVE_AUDIO_DEVICE_SAMPLE_RATE, nativeAudioDeviceEngine } from './native-audio-device'
import { createNativeSpeechServer } from './native-speech'
import { nativeSpeechDeviceEngine } from './native-speech-device'
import { serveNativeClipboardVerb } from './native-clipboard'
import { serveNativeAnnounceVerb } from './native-accessibility-announce'
import { createNativeMediaVerbServer } from './native-media'
import { discardStagedMedia, nativeMediaDeviceDeps } from './native-media-device'

export type NativeDeviceVerb = Exclude<
  BridgeNativeVerb,
  | 'native.storage.read'
  | 'native.pdf.view'
  | 'native.image.act'
  | 'native.browser.local'
  | typeof BRIDGE_STORE_VERB
>

// Tie stateful audio/media handlers to the page session so replacement documents cannot inherit abandoned microphones or staged handles.
export function useNativeDeviceVerbs(
  sessionId: string | null
): (verb: NativeDeviceVerb, params: unknown) => Promise<unknown> {
  const registry = useMediaHandleRegistry({ sessionId, discard: discardStagedMedia })
  const serveMedia = useMemo(
    () => createNativeMediaVerbServer(nativeMediaDeviceDeps(registry)),
    [registry]
  )
  // A new session is a new document; close any mic its predecessor left open.
  const audio = useMemo(() => createNativeAudioCapture(nativeAudioDeviceEngine), [sessionId])
  useEffect(() => () => audio.dispose(), [audio])
  const speech = useMemo(() => createNativeSpeechServer(nativeSpeechDeviceEngine), [sessionId])
  useEffect(() => () => speech.dispose(), [speech])
  return useMemo(
    () => (verb, params) => {
      if (verb === 'native.clipboard.write' || verb === 'native.clipboard.read') {
        return serveNativeClipboardVerb(verb, params)
      }
      if (verb === 'native.speech.act') {
        return speech.serve(params)
      }
      if (verb === 'native.a11y.announce') {
        return Promise.resolve(serveNativeAnnounceVerb(params))
      }
      if (verb === 'native.audio.start') {
        return speech.mayCapture().then((may) =>
          may
            ? audio.serve(verb, params)
            : {
                started: false,
                sampleRate: NATIVE_AUDIO_DEVICE_SAMPLE_RATE,
                permission: 'granted'
              }
        )
      }
      return verb.startsWith('native.audio.') ? audio.serve(verb, params) : serveMedia(verb, params)
    },
    [audio, serveMedia, speech]
  )
}
