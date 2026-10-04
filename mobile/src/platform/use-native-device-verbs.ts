import { useEffect, useMemo } from 'react'
import type { BridgeNativeVerb } from '../mobile-web-shell/bridge/bridge-native-verbs'
import { useMediaHandleRegistry } from '../mobile-web-shell/use-media-handle-registry'
import { createNativeAudioCapture } from './native-audio'
import { nativeAudioDeviceEngine } from './native-audio-device'
import { serveNativeClipboardVerb } from './native-clipboard'
import { createNativeMediaVerbServer } from './native-media'
import { discardStagedMedia, nativeMediaDeviceDeps } from './native-media-device'

/**
 * Every `native.` verb this device serves, behind the one function the host dispatches to.
 *
 * Built here rather than in the screen because most of them are stateful where the clipboard ones
 * are not: the media verbs hold staged files and the audio verbs hold a live microphone, and both
 * have to be born and released with the page session. The screen passes a session id and gets a
 * handler whose lifetime already matches it.
 */
export function useNativeDeviceVerbs(
  sessionId: string | null
): (verb: BridgeNativeVerb, params: unknown) => Promise<unknown> {
  const registry = useMediaHandleRegistry({ sessionId, discard: discardStagedMedia })
  const serveMedia = useMemo(
    () => createNativeMediaVerbServer(nativeMediaDeviceDeps(registry)),
    [registry]
  )
  // Keyed on the session for the registry's reason: a new page session is a new document, and a
  // microphone the previous one left open is nobody's to stop but this seam's.
  const audio = useMemo(() => createNativeAudioCapture(nativeAudioDeviceEngine), [sessionId])
  useEffect(() => () => audio.dispose(), [audio])
  return useMemo(
    () => (verb, params) => {
      if (verb === 'native.clipboard.write' || verb === 'native.clipboard.read') {
        return serveNativeClipboardVerb(verb, params)
      }
      return verb.startsWith('native.audio.') ? audio.serve(verb, params) : serveMedia(verb, params)
    },
    [audio, serveMedia]
  )
}
