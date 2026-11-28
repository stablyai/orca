import { useEffect, useMemo } from 'react'
import type { BridgeNativeVerb } from '../mobile-web-shell/bridge/native-capabilities/bridge-native-verbs'
import type { BRIDGE_STORE_VERB } from '../mobile-web-shell/bridge/native-capabilities/bridge-store-verb'
import { useMediaHandleRegistry } from '../mobile-web-shell/native-capabilities/use-media-handle-registry'
import { createNativeAudioCapture } from './audio-capture/native-audio'
import {
  NATIVE_AUDIO_DEVICE_SAMPLE_RATE,
  nativeAudioDeviceEngine
} from './audio-capture/native-audio-device'
import { createNativeSpeechServer } from './speech/native-speech'
import { nativeSpeechDeviceEngine } from './speech/native-speech-device'
import { serveNativeClipboardVerb } from './clipboard/native-clipboard'
import { serveNativeAnnounceVerb } from './accessibility/native-accessibility-announce'
import { serveNativeLinkOpenVerb } from './external-links/native-link-open-verb'
import { createNativeMediaVerbServer } from './media-picking/native-media'
import { discardStagedMedia, nativeMediaDeviceDeps } from './media-picking/native-media-device'
import { recomputeOn } from '../hooks/recompute-on'
import { BRIDGE_DIRECT_PAIRINGS_VERB } from '../mobile-web-shell/bridge/native-capabilities/bridge-direct-pairings-verb'
import { directPairingInstallationIds } from '../host-descriptors/direct-pairing-installations'

export type NativeDeviceVerb = Exclude<
  BridgeNativeVerb,
  | 'native.storage.read'
  | 'native.pdf.view'
  | 'native.file.share'
  | 'native.image.act'
  | typeof BRIDGE_STORE_VERB
>

// Tie stateful audio/media handlers to the page session so replacement documents cannot inherit abandoned microphones or staged handles.
export function useNativeDeviceVerbs(
  sessionId: string | null,
  // The page's own host: a direct pairing counts only if it reaches as far as this host relays.
  hostId: string
): (verb: NativeDeviceVerb, params: unknown) => Promise<unknown> {
  const registry = useMediaHandleRegistry({ sessionId, discard: discardStagedMedia })
  const serveMedia = useMemo(
    () => createNativeMediaVerbServer(nativeMediaDeviceDeps(registry)),
    [registry]
  )
  // A new session is a new document; close any mic its predecessor left open.
  const audio = useMemo(
    () => recomputeOn([sessionId], () => createNativeAudioCapture(nativeAudioDeviceEngine)),
    [sessionId]
  )
  useEffect(() => () => audio.dispose(), [audio])
  const speech = useMemo(
    () => recomputeOn([sessionId], () => createNativeSpeechServer(nativeSpeechDeviceEngine)),
    [sessionId]
  )
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
      if (verb === 'native.link.open') {
        return serveNativeLinkOpenVerb(params)
      }
      if (verb === BRIDGE_DIRECT_PAIRINGS_VERB) {
        return Promise.resolve({ installationIds: directPairingInstallationIds(hostId) })
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
    [audio, hostId, serveMedia, speech]
  )
}
