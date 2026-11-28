import { presentPdf } from '../../../modules/orca-mobile-web-shell/src/index'
import { pdfViewParamsSchema } from '../../mobile-web-shell/bridge/native-capabilities/bridge-native-verbs'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  createNativeHostFileHandoff,
  useNativeHostFileHandoff
} from '../host-file-handoff/native-host-file-handoff'

export function createNativePdfViewer(
  readClient: () => RpcClient | null,
  isFocused: () => boolean
) {
  const handoff = createNativeHostFileHandoff({
    folder: 'orca-pdf',
    noun: 'PDF',
    outdatedHostCode: 'native_pdf_host_outdated',
    allowEmpty: false,
    readClient,
    isFocused,
    present: (uri) => presentPdf(uri)
  })
  return {
    serve: async (params: unknown): Promise<Record<string, never>> => {
      const request = pdfViewParamsSchema.parse(params)
      if (request.action === 'open') {
        await handoff.open(request)
      } else {
        handoff.cancel()
      }
      return {}
    },
    dispose: handoff.cancel
  }
}

export function useNativePdfViewer(
  hostId: string,
  sessionId: string | null
): (params: unknown) => Promise<unknown> {
  return useNativeHostFileHandoff(hostId, sessionId, createNativePdfViewer).serve
}
