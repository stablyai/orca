import { downloadMobileFileMedia, type MobileMediaSink } from '../files/mobile-file-media-download'
import type { MobileFilePreviewRpcSender } from '../files/mobile-file-preview-operations'
import type { BridgeFileShareParams } from '../mobile-web-shell/bridge/bridge-native-verbs'
import { BridgeNativeVerbRefusedError } from '../mobile-web-shell/bridge-host-errors'

// A page inside the WebView can neither write a cache file nor reach the OS share sheet, so the shell owns the hand-off.
export const MOBILE_SHARE_FILE_PREFIX = 'orca-share-'

// Stay under the 255-byte filename cap every platform we ship on enforces, leaving the stamped prefix room to fit.
export const MOBILE_SHARE_FILE_NAME_MAX_CHARS = 200

// Stamped files outlive the session that made them; sweep the ones no viewer can still be reading.
export const MOBILE_SHARE_FILE_STALE_AFTER_MS = 10 * 60 * 1000

export type NativeSharedFile = {
  uri: string
  delete: () => void
}

export type NativeFileShareDeps = {
  writeCacheFile: (name: string, bytes: Uint8Array) => NativeSharedFile
  shareFile: (
    file: NativeSharedFile,
    options: { mimeType: string; dialogTitle: string }
  ) => Promise<void>
}

export function mobileShareFileName(relativePath: string, stamp: number): string {
  const rawName = (relativePath.split(/[/\\]/).pop() ?? 'document').replace(/[^a-zA-Z0-9._-]/g, '_')
  const extension = rawName.toLowerCase().endsWith('.pdf') ? '.pdf' : ''
  const stem = (extension ? rawName.slice(0, -extension.length) : rawName) || 'document'
  const prefix = `${MOBILE_SHARE_FILE_PREFIX}${stamp}-`
  const maxStemLength = Math.max(
    1,
    MOBILE_SHARE_FILE_NAME_MAX_CHARS - prefix.length - extension.length
  )
  return `${prefix}${stem.slice(0, maxStemLength)}${extension}`
}

export function createNativeFileShareServer(deps: NativeFileShareDeps) {
  // Keep one handed-off file alive until the next request replaces it: the viewer may read it after the sheet closes.
  let lastShared: NativeSharedFile | null = null

  return async function shareFile(
    client: MobileFilePreviewRpcSender | null,
    params: BridgeFileShareParams
  ): Promise<{ shared: boolean }> {
    if (client === null) {
      throw new BridgeNativeVerbRefusedError(
        'native_verb_failed',
        'this shell has no desktop connection to read the file from'
      )
    }
    discardQuietly(lastShared)
    lastShared = null

    const parts: Uint8Array[] = []
    const sink: MobileMediaSink = {
      append: (bytes) => {
        parts.push(new Uint8Array(bytes))
      },
      finish: () => '',
      dispose: () => {
        parts.length = 0
      }
    }
    try {
      await downloadMobileFileMedia(
        client,
        {
          worktreeId: params.worktreeId,
          relativePath: params.relativePath,
          mimeType: params.mimeType
        },
        sink,
        new AbortController().signal,
        () => {}
      )
    } catch (error) {
      throw new BridgeNativeVerbRefusedError(
        'native_verb_failed',
        error instanceof Error ? error.message : 'the file could not be downloaded'
      )
    }

    const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      bytes.set(part, offset)
      offset += part.byteLength
    }
    parts.length = 0

    const file = deps.writeCacheFile(mobileShareFileName(params.relativePath, Date.now()), bytes)
    try {
      await deps.shareFile(file, {
        mimeType: params.mimeType,
        dialogTitle: params.title
      })
    } catch (error) {
      discardQuietly(file)
      throw new BridgeNativeVerbRefusedError(
        'native_verb_failed',
        error instanceof Error ? error.message : 'this device has no app to open the file'
      )
    }
    lastShared = file
    return { shared: true }
  }
}

function discardQuietly(file: NativeSharedFile | null): void {
  if (file === null) {
    return
  }
  try {
    file.delete()
  } catch (error) {
    // The cache is the OS's to reclaim; cleanup must not replace the share result.
    console.warn('[web-shell] a shared file could not be deleted', { uri: file.uri }, error)
  }
}
