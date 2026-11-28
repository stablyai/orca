import { shareFile } from '../../../modules/orca-mobile-web-shell/src/index'
import { fileShareParamsSchema } from '../../mobile-web-shell/bridge/native-capabilities/bridge-native-verbs'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  createNativeHostFileHandoff,
  useNativeHostFileHandoff
} from '../host-file-handoff/native-host-file-handoff'

// Android's share intent needs a type; iOS reads it from the file's extension.
const UNKNOWN_FILE_MIME = 'application/octet-stream'

// Serves native.file.share: the system share sheet (Save to Files on iOS) for any workspace file up to the download cap.
export function createNativeFileSharer(
  readClient: () => RpcClient | null,
  isFocused: () => boolean
) {
  const handoff = createNativeHostFileHandoff({
    folder: 'orca-file-share',
    noun: 'file',
    outdatedHostCode: 'native_file_host_outdated',
    allowEmpty: true,
    readClient,
    isFocused,
    // The image share's native code takes any file: iOS hands the URL to the activity sheet, Android sends the content URI.
    present: (uri, file) => shareFile(uri, file.type || UNKNOWN_FILE_MIME)
  })
  return {
    serve: async (params: unknown): Promise<Record<string, never>> => {
      const request = fileShareParamsSchema.parse(params)
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

export function useNativeFileSharer(
  hostId: string,
  sessionId: string | null
): (params: unknown) => Promise<unknown> {
  return useNativeHostFileHandoff(hostId, sessionId, createNativeFileSharer).serve
}
