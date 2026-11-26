import { useNativeDeviceVerbs } from '../platform/use-native-device-verbs'
import { useNativePdfViewer } from '../platform/pdf-viewing/native-pdf-view'
import { useNativeImageActions } from '../platform/image-actions/native-image-actions'
import { processDeviceStore } from '../device-store/device-store'
import { serveDeviceStoreVerb } from './native-capabilities/device-store-verb-server'
import { BRIDGE_STORE_VERB } from './bridge/native-capabilities/bridge-store-verb'
import {
  storageReadParamsSchema,
  type BridgeNativeVerb
} from './bridge/native-capabilities/bridge-native-verbs'

/** Serves the page's native verbs for one page session; staged files belong to that session. */
export function useShellNativeVerbs(
  hostId: string,
  sessionId: string | null,
  readWorkspaceKey: (key: string) => Promise<unknown>
): (verb: BridgeNativeVerb, params: unknown) => Promise<unknown> {
  const serveDeviceVerb = useNativeDeviceVerbs(sessionId)
  const servePdfView = useNativePdfViewer(hostId, sessionId)
  const serveImageAction = useNativeImageActions(sessionId)
  // Read the shell's storage for this host.
  return (verb, params) =>
    verb === 'native.storage.read'
      ? readWorkspaceKey(storageReadParamsSchema.parse(params).key).then((value) => ({ value }))
      : verb === 'native.pdf.view'
        ? servePdfView(params)
        : verb === 'native.image.act'
          ? serveImageAction(params)
          : verb === BRIDGE_STORE_VERB
            ? serveDeviceStoreVerb(processDeviceStore(), hostId, params)
            : serveDeviceVerb(verb, params)
}
