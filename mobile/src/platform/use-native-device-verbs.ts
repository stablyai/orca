import { useMemo } from 'react'
import type { BridgeNativeVerb } from '../mobile-web-shell/bridge/bridge-native-verbs'
import { useMediaHandleRegistry } from '../mobile-web-shell/use-media-handle-registry'
import { serveNativeClipboardVerb } from './native-clipboard'
import { createNativeMediaVerbServer } from './native-media'
import { discardStagedMedia, nativeMediaDeviceDeps } from './native-media-device'

/**
 * Every `native.` verb this device serves, behind the one function the host dispatches to.
 *
 * Built here rather than in the screen because the media verbs are stateful where the clipboard
 * ones are not: they hold staged files, and the registry that owns them has to be born and swept
 * with the page session. The screen passes a session id and gets a handler whose lifetime already
 * matches it.
 */
export function useNativeDeviceVerbs(
  sessionId: string | null
): (verb: BridgeNativeVerb, params: unknown) => Promise<unknown> {
  const registry = useMediaHandleRegistry({ sessionId, discard: discardStagedMedia })
  const serveMedia = useMemo(
    () => createNativeMediaVerbServer(nativeMediaDeviceDeps(registry)),
    [registry]
  )
  return useMemo(
    () => (verb, params) =>
      verb === 'native.clipboard.write' || verb === 'native.clipboard.read'
        ? serveNativeClipboardVerb(verb, params)
        : serveMedia(verb, params),
    [serveMedia]
  )
}
