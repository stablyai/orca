import { useNativeDeviceVerbs } from '../../platform/use-native-device-verbs'
import { useNativePdfViewer } from '../../platform/pdf-viewing/native-pdf-view'
import { useNativeImageActions } from '../../platform/image-actions/native-image-actions'
import { processDeviceStore } from '../../device-store/device-store'
import type { GenerationStore } from '../generations/generation-store'
import { serveDeviceStoreVerb } from './device-store-verb-server'
import { useDeferredCodeServer } from './deferred-code-verb-server'
import { BRIDGE_STORE_VERB } from '../bridge/native-capabilities/bridge-store-verb'
import { BRIDGE_DEFERRED_CODE_VERB } from '../bridge/protocol/bridge-frame-fields'
import {
  storageReadParamsSchema,
  type BridgeNativeVerb
} from '../bridge/native-capabilities/bridge-native-verbs'

// Every verb the shown page may call, served on this device; media and staged files belong to its session.
export function useShellNativeVerbServer(args: {
  hostId: string
  sessionId: string | null
  buildId: string | null
  store: GenerationStore
  readWorkspaceKey: (key: string) => Promise<string | null>
}): (verb: BridgeNativeVerb, params: unknown) => Promise<unknown> {
  const { hostId, sessionId, readWorkspaceKey } = args
  const serveDeviceVerb = useNativeDeviceVerbs(sessionId, hostId)
  const servePdfView = useNativePdfViewer(hostId, sessionId)
  const serveImageAction = useNativeImageActions(sessionId)
  const serveDeferredCode = useDeferredCodeServer(hostId, args.buildId, args.store)
  return (verb, params) =>
    verb === 'native.storage.read'
      ? readWorkspaceKey(storageReadParamsSchema.parse(params).key).then((value) => ({ value }))
      : verb === 'native.pdf.view'
        ? servePdfView(params)
        : verb === 'native.image.act'
          ? serveImageAction(params)
          : verb === BRIDGE_STORE_VERB
            ? serveDeviceStoreVerb(processDeviceStore(), hostId, params)
            : verb === BRIDGE_DEFERRED_CODE_VERB
              ? serveDeferredCode(params)
              : serveDeviceVerb(verb, params)
}
