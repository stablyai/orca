import { useEffect, useMemo } from 'react'
import type { MobileFilePreviewRpcSender } from '../files/mobile-file-preview-operations'
import {
  fileShareParamsSchema,
  type BridgeNativeVerb
} from '../mobile-web-shell/bridge/bridge-native-verbs'
import { useMediaHandleRegistry } from '../mobile-web-shell/use-media-handle-registry'
import { createNativeAudioCapture } from './native-audio'
import { nativeAudioDeviceEngine } from './native-audio-device'
import { serveNativeClipboardVerb } from './native-clipboard'
import { createNativeFileShareServer } from './native-file-share'
import { nativeFileShareDeviceDeps } from './native-file-share-device'
import { createNativeMediaVerbServer } from './native-media'
import { discardStagedMedia, nativeMediaDeviceDeps } from './native-media-device'

export type NativeDeviceVerb = Exclude<BridgeNativeVerb, 'native.storage.read'>

// Tie stateful audio/media handlers to the page session so replacement documents cannot inherit abandoned microphones or staged handles.
export function useNativeDeviceVerbs(
  sessionId: string | null,
  client: MobileFilePreviewRpcSender | null
): (verb: NativeDeviceVerb, params: unknown) => Promise<unknown> {
  const registry = useMediaHandleRegistry({ sessionId, discard: discardStagedMedia })
  const serveMedia = useMemo(
    () => createNativeMediaVerbServer(nativeMediaDeviceDeps(registry)),
    [registry]
  )
  // A new session is a new document; close any mic its predecessor left open.
  const audio = useMemo(() => createNativeAudioCapture(nativeAudioDeviceEngine), [sessionId])
  // The shell reads the bytes itself: a PDF is too large for a page frame and the page cannot hand a file to the OS.
  const shareFile = useMemo(() => createNativeFileShareServer(nativeFileShareDeviceDeps()), [])
  useEffect(() => () => audio.dispose(), [audio])
  return useMemo(
    () => (verb, params) => {
      if (verb === 'native.clipboard.write' || verb === 'native.clipboard.read') {
        return serveNativeClipboardVerb(verb, params)
      }
      if (verb === 'native.file.share') {
        return shareFile(client, fileShareParamsSchema.parse(params))
      }
      return verb.startsWith('native.audio.') ? audio.serve(verb, params) : serveMedia(verb, params)
    },
    [audio, serveMedia, shareFile, client]
  )
}
