import { useNativeDeviceVerbs } from '../../platform/use-native-device-verbs'
import { useNativePdfViewer } from '../../platform/pdf-viewing/native-pdf-view'
import { useNativeImageActions } from '../../platform/image-actions/native-image-actions'
import type { PageDialogQueue } from '../../platform/page-dialogs/page-dialog-queue'
import { processDeviceStore } from '../../device-store/device-store'
import { serveDeviceStoreVerb } from './device-store-verb-server'
import { BRIDGE_STORE_VERB } from '../bridge/native-capabilities/bridge-store-verb'
import { BRIDGE_DIALOG_VERB } from '../bridge/native-capabilities/bridge-dialog-verb'
import {
  storageReadParamsSchema,
  type BridgeNativeVerb
} from '../bridge/native-capabilities/bridge-native-verbs'

// Route each verb to the handler that owns it; stateful handlers are tied to the page session.
export function useShellNativeVerbServer(args: {
  hostId: string
  sessionId: string | null
  readWorkspaceKey: (key: string) => Promise<string | null>
  dialogs: PageDialogQueue
}): (verb: BridgeNativeVerb, params: unknown) => Promise<unknown> {
  const { hostId, sessionId, readWorkspaceKey, dialogs } = args
  // Create the media registry before the bridge; staged files belong to this page session.
  const serveDeviceVerb = useNativeDeviceVerbs(sessionId)
  const servePdfView = useNativePdfViewer(hostId, sessionId)
  const serveImageAction = useNativeImageActions(sessionId)
  return (verb, params) => {
    // Read the shell's storage for this host.
    if (verb === 'native.storage.read') {
      return readWorkspaceKey(storageReadParamsSchema.parse(params).key).then((value) => ({
        value
      }))
    }
    if (verb === 'native.pdf.view') {
      return servePdfView(params)
    }
    if (verb === 'native.image.act') {
      return serveImageAction(params)
    }
    if (verb === BRIDGE_STORE_VERB) {
      return serveDeviceStoreVerb(processDeviceStore(), hostId, params)
    }
    if (verb === BRIDGE_DIALOG_VERB) {
      return dialogs.serve(params)
    }
    // Every other verb is a device capability.
    return serveDeviceVerb(verb, params)
  }
}
