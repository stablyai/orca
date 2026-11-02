import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { Platform } from 'react-native'
import { Directory, File as FsFile, Paths } from 'expo-file-system'
import { useFocusEffect, useNavigation } from 'expo-router'
import { presentPdf } from '../../modules/orca-mobile-web-shell/src'
import { getRuntimePathBasename } from '../../../src/shared/cross-platform-path'
import { PDF_MIME_TYPE } from '../files/mobile-file-media'
import {
  downloadMobileFileMedia,
  MobileMediaHostOutdatedError,
  type MobileMediaSink
} from '../files/mobile-file-media-download'
import {
  pdfViewParamsSchema,
  type BridgePdfOpenParams
} from '../mobile-web-shell/bridge/bridge-native-verbs'
import { BridgeNativeVerbRefusedError } from '../mobile-web-shell/bridge-host-errors'
import { scopeRpcClientToExecutionHost } from '../transport/execution-host-scoped-rpc-client'
import { useHostClient } from '../transport/host-client-hooks'
import { discardUnreturnedMediaFile } from './native-media-device'
import type { RpcClient } from '../transport/rpc-client'

function pdfFileSink(file: FsFile): MobileMediaSink {
  file.create({ overwrite: true })
  const handle = file.open()
  return {
    append: (bytes) => handle.writeBytes(bytes),
    finish: () => {
      handle.close()
      return Platform.OS === 'android' ? file.contentUri : file.uri
    },
    dispose: () => {
      handle.close()
      discardUnreturnedMediaFile(file)
    }
  }
}

// An external viewer may still read the last PDF, so earlier ones are cleared only when the next starts.
// Each open gets its own folder so an aborted download's cleanup cannot delete its replacement.
export function createNativePdfViewer(
  readClient: () => RpcClient | null,
  isFocused: () => boolean
) {
  let current: AbortController | null = null
  const open = async ({
    worktreeId,
    relativePath,
    executionHost
  }: BridgePdfOpenParams): Promise<Record<string, never>> => {
    if (!isFocused()) {
      throw new Error('the PDF page is not focused')
    }
    const client = readClient()
    if (!client) {
      throw new Error('no desktop connection to download the PDF from')
    }
    current?.abort()
    const controller = new AbortController()
    current = controller
    const root = new Directory(Paths.cache, 'orca-pdf')
    if (root.exists) {
      root.delete()
    }
    const folder = new Directory(root, `${Date.now()}-${Math.random().toString(36).slice(2)}`)
    folder.create({ intermediates: true })
    const uri = await downloadMobileFileMedia(
      executionHost ? scopeRpcClientToExecutionHost(client, executionHost) : client,
      { worktreeId, relativePath, mimeType: PDF_MIME_TYPE },
      pdfFileSink(new FsFile(folder, getRuntimePathBasename(relativePath))),
      controller.signal,
      () => {}
    ).catch((error: unknown) => {
      throw error instanceof MobileMediaHostOutdatedError
        ? new BridgeNativeVerbRefusedError('native_pdf_host_outdated', error.message)
        : error
    })
    if (controller.signal.aborted) {
      throw new Error('the PDF open was cancelled')
    }
    await presentPdf(uri)
    return {}
  }
  return {
    serve: async (params: unknown): Promise<Record<string, never>> => {
      const request = pdfViewParamsSchema.parse(params)
      if (request.action === 'open') {
        return open(request)
      }
      current?.abort()
      return {}
    },
    dispose: () => current?.abort()
  }
}

// A replaced, closed or covered shell must not have a viewer pop up over whatever screen comes next.
export function useNativePdfViewer(
  hostId: string,
  sessionId: string | null
): (params: unknown) => Promise<unknown> {
  const { client } = useHostClient(hostId)
  const navigation = useNavigation()
  const clientRef = useRef(client)
  useLayoutEffect(() => {
    clientRef.current = client
  }, [client])
  const viewer = useMemo(
    () => createNativePdfViewer(() => clientRef.current, navigation.isFocused),
    [navigation, sessionId]
  )
  useFocusEffect(useCallback(() => () => viewer.dispose(), [viewer]))
  return viewer.serve
}
