import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { Platform } from 'react-native'
import { File as FsFile } from 'expo-file-system'
import { useFocusEffect, useNavigation } from 'expo-router'
import { getRuntimePathBasename } from '../../../../src/shared/file-access/cross-platform-path'
import {
  downloadMobileFileMedia,
  MobileMediaHostOutdatedError,
  MobileMediaTooLargeError,
  type MobileMediaSink
} from '../../files/media/mobile-file-media-download'
import {
  BridgeNativeVerbRefusedError,
  type BridgeNativeRefusalCode
} from '../../mobile-web-shell/host-bridge/bridge-host-errors'
import { scopeRpcClientToExecutionHost } from '../../worktree/execution-hosts/execution-host-scoped-rpc-client'
import { useHostClient } from '../../transport/connection/host-client-hooks'
import { discardUnreturnedMediaFile, freshCacheFolder } from '../media-picking/native-media-device'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { recomputeOn } from '../../hooks/recompute-on'

export type HostFileRequest = {
  worktreeId: string
  relativePath: string
  executionHost?: `runtime:${string}`
}

function cacheFileSink(file: FsFile): MobileMediaSink {
  file.create({ overwrite: true })
  const handle = file.open()
  return {
    append: (bytes) => handle.writeBytesSync(bytes),
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

/**
 * Downloads one workspace file into the phone's cache, named as on the host, and hands it to a system
 * viewer or sheet. One at a time: a newer open or a cancel abandons the older download. The file stays
 * after handing it off, since the app the user picks may read it later; the next open clears the folder.
 */
export function createNativeHostFileHandoff(options: {
  /** The cache folder, cleared on each open. */
  folder: string
  /** Names what failed in errors the shell logs; the page shows its own copy per code. */
  noun: string
  outdatedHostCode: BridgeNativeRefusalCode
  allowEmpty: boolean
  readClient: () => RpcClient | null
  isFocused: () => boolean
  present: (uri: string, file: FsFile) => Promise<void>
}) {
  let current: AbortController | null = null
  return {
    open: async ({ worktreeId, relativePath, executionHost }: HostFileRequest): Promise<void> => {
      if (!options.isFocused()) {
        throw new Error(`the ${options.noun} page is not focused`)
      }
      const client = options.readClient()
      if (!client) {
        throw new Error(`no desktop connection to download the ${options.noun} from`)
      }
      current?.abort()
      const controller = new AbortController()
      current = controller
      const file = new FsFile(
        freshCacheFolder(options.folder),
        getRuntimePathBasename(relativePath)
      )
      const uri = await downloadMobileFileMedia(
        executionHost ? scopeRpcClientToExecutionHost(client, executionHost) : client,
        { worktreeId, relativePath },
        cacheFileSink(file),
        controller.signal,
        () => {},
        { allowEmpty: options.allowEmpty }
      ).catch((error: unknown) => {
        if (error instanceof MobileMediaHostOutdatedError) {
          throw new BridgeNativeVerbRefusedError(options.outdatedHostCode, error.message)
        }
        if (error instanceof MobileMediaTooLargeError) {
          throw new BridgeNativeVerbRefusedError('native_media_too_large', error.message)
        }
        throw error
      })
      // A page the user left or covered must not have a sheet pop up over whatever came next.
      if (controller.signal.aborted || !options.isFocused()) {
        throw new Error(`the ${options.noun} open was cancelled`)
      }
      await options.present(uri, file)
    },
    cancel: () => current?.abort()
  }
}

// A replaced, closed or covered shell must not have a viewer or sheet pop up over whatever screen comes next.
export function useNativeHostFileHandoff<Handoff extends { dispose: () => void }>(
  hostId: string,
  sessionId: string | null,
  create: (readClient: () => RpcClient | null, isFocused: () => boolean) => Handoff
): Handoff {
  const { client } = useHostClient(hostId)
  const navigation = useNavigation()
  const clientRef = useRef(client)
  useLayoutEffect(() => {
    clientRef.current = client
  }, [client])
  // `create` is module-level, so a new handoff comes only with a new page session.
  const handoff = useMemo(
    () => recomputeOn([sessionId], () => create(() => clientRef.current, navigation.isFocused)),
    [create, navigation, sessionId]
  )
  useFocusEffect(useCallback(() => () => handoff.dispose(), [handoff]))
  return handoff
}
