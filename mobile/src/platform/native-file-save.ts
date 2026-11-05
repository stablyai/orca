import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { Directory, File as FsFile } from 'expo-file-system'
import { useFocusEffect, useNavigation } from 'expo-router'
import { getRuntimePathBasename } from '../../../src/shared/cross-platform-path'
import { mobileFileMediaMime } from '../files/mobile-file-media'
import {
  downloadMobileFileMedia,
  MobileMediaHostOutdatedError,
  type MobileMediaSink
} from '../files/mobile-file-media-download'
import {
  fileSaveParamsSchema,
  type BridgeFileSaveParams
} from '../mobile-web-shell/bridge/bridge-native-verbs'
import { BridgeNativeVerbRefusedError } from '../mobile-web-shell/bridge-host-errors'
import { scopeRpcClientToExecutionHost } from '../transport/execution-host-scoped-rpc-client'
import { useHostClient } from '../transport/host-client-hooks'
import type { RpcClient } from '../transport/rpc-client'

const GENERIC_MIME_TYPE = 'application/octet-stream'

// Append per chunk: Expo's FileHandle rejects Android SAF content: URIs, but File.write(append) works on them and on iOS security-scoped folders.
function pickedFolderSink(file: FsFile): MobileMediaSink {
  return {
    append: (bytes) => file.write(bytes, { append: true }),
    finish: () => file.uri,
    dispose: () => {
      try {
        file.delete()
      } catch {
        // Best effort; a partial file the user can delete beats masking the download error.
      }
    }
  }
}

// The picker rejects (rather than resolving empty) when dismissed, on both platforms.
function isPickerDismissal(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? String(error.code) : ''
  return error instanceof Error && /cancel/i.test(`${error.message} ${code}`)
}

export function createNativeFileSaver(
  readClient: () => RpcClient | null,
  isFocused: () => boolean,
  pickFolder: () => Promise<Directory> = () => Directory.pickDirectoryAsync()
) {
  let current: AbortController | null = null
  const save = async ({
    worktreeId,
    relativePath,
    executionHost
  }: BridgeFileSaveParams): Promise<{ saved: boolean }> => {
    if (!isFocused()) {
      throw new Error('the file page is not focused')
    }
    const client = readClient()
    if (!client) {
      throw new Error('no desktop connection to download the file from')
    }
    current?.abort()
    const controller = new AbortController()
    current = controller
    let folder: Directory
    try {
      folder = await pickFolder()
    } catch (error) {
      if (isPickerDismissal(error)) {
        return { saved: false }
      }
      throw error
    }
    if (controller.signal.aborted) {
      throw new Error('the file save was cancelled')
    }
    const mimeType = mobileFileMediaMime(relativePath) ?? GENERIC_MIME_TYPE
    const file = folder.createFile(getRuntimePathBasename(relativePath), mimeType)
    await downloadMobileFileMedia(
      executionHost ? scopeRpcClientToExecutionHost(client, executionHost) : client,
      { worktreeId, relativePath, mimeType },
      pickedFolderSink(file),
      controller.signal,
      () => {},
      { allowEmpty: true }
    ).catch((error: unknown) => {
      throw error instanceof MobileMediaHostOutdatedError
        ? new BridgeNativeVerbRefusedError('native_file_save_host_outdated', error.message)
        : error
    })
    return { saved: true }
  }
  return {
    serve: async (params: unknown): Promise<{ saved: boolean }> => {
      const request = fileSaveParamsSchema.parse(params)
      if (request.action === 'save') {
        return save(request)
      }
      current?.abort()
      return { saved: false }
    },
    dispose: () => current?.abort()
  }
}

// A replaced or covered shell must not keep downloading into a folder the user picked for a page they left.
export function useNativeFileSaver(
  hostId: string,
  sessionId: string | null
): (params: unknown) => Promise<unknown> {
  const { client } = useHostClient(hostId)
  const navigation = useNavigation()
  const clientRef = useRef(client)
  useLayoutEffect(() => {
    clientRef.current = client
  }, [client])
  const saver = useMemo(
    () => createNativeFileSaver(() => clientRef.current, navigation.isFocused),
    [navigation, sessionId]
  )
  useFocusEffect(useCallback(() => () => saver.dispose(), [saver]))
  return saver.serve
}
