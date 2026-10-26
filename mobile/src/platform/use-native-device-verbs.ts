import { useEffect, useMemo } from 'react'
import type { BridgeNativeVerb } from '../mobile-web-shell/bridge/bridge-native-verbs'
import { useMediaHandleRegistry } from '../mobile-web-shell/use-media-handle-registry'
import { createNativeAudioCapture } from './native-audio'
import { nativeAudioDeviceEngine } from './native-audio-device'
import { serveNativeClipboardVerb } from './native-clipboard'
import { createNativeMediaVerbServer } from './native-media'
import { discardStagedMedia, nativeMediaDeviceDeps } from './native-media-device'

export type NativeDeviceVerb = Exclude<BridgeNativeVerb, 'native.storage.read'>

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
