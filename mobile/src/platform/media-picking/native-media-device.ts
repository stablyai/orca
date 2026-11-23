import * as Clipboard from 'expo-clipboard'
import * as DocumentPicker from 'expo-document-picker'
import { Directory, File as FsFile, Paths } from 'expo-file-system'
import * as ImagePicker from 'expo-image-picker'
import { agentReadableLibraryImageOptions } from '../../files/attachments/mobile-image-source-picker'
import type { MediaHandleRegistry } from '../../mobile-web-shell/native-capabilities/media-handle-registry'
import type { NativeMediaDeps } from './native-media'
import { BridgeNativeVerbRefusedError } from '../../mobile-web-shell/host-bridge/bridge-host-errors'
import { CLIPBOARD_IMAGE_MAX_SOURCE_BYTES } from '../../../../src/shared/clipboard/clipboard-image'
import { AGENT_SESSION_ATTACHMENT_CHUNK_BYTES as STAGING_COPY_CHUNK_BYTES } from '../../../../src/shared/agent-session/agent-session-attachments'

// Isolate native imports so handlers can be tested with injected device calls.
// Android may return an uncopied content: URI; copy it into cache before minting a handle whose release deletes the file.
export function ownsStagedMediaUri(uri: string): boolean {
  return uri.startsWith('file:')
}

function stagedMediaFile(extension: string): FsFile {
  return new FsFile(Paths.cache, `orca-media-${Date.now()}-${Math.random()}.${extension}`)
}

// Another app may still read the last file handed to it, so a folder's earlier contents are cleared only when the next one starts.
// Each start gets its own subfolder so an aborted run's cleanup cannot delete its replacement.
export function freshCacheFolder(name: string): Directory {
  const root = new Directory(Paths.cache, name)
  if (root.exists) {
    root.delete()
  }
  const folder = new Directory(root, `${Date.now()}-${Math.random().toString(36).slice(2)}`)
  folder.create({ intermediates: true })
  return folder
}

export function discardUnreturnedMediaFile(file: FsFile): void {
  try {
    file.delete()
  } catch {
    // Best effort; the cache is the OS's to reclaim.
  }
}

// Use bytesSync(): Expo copy/open/stream paths require javaFile and reject content: URIs. The caller must weigh first because this read holds the whole file in memory.
// Files may be as large as an upload; copying them whole would hold the file in JS memory.
function copyFileInChunks(source: FsFile, destination: FsFile): void {
  const reader = source.open()
  try {
    const writer = destination.open()
    try {
      for (;;) {
        const bytes = reader.readBytesSync(STAGING_COPY_CHUNK_BYTES)
        if (bytes.byteLength === 0) {
          return
        }
        writer.writeBytesSync(bytes)
      }
    } finally {
      writer.close()
    }
  } finally {
    reader.close()
  }
}

export function copyPickedMediaIntoCache(uri: string): string {
  const destination = stagedMediaFile('bin')
  destination.create({ overwrite: true })
  try {
    const source = new FsFile(uri)
    if (uri.startsWith('file:')) {
      copyFileInChunks(source, destination)
    } else {
      // Expo reads provider URIs only whole, so those stay within the in-memory image ceiling.
      if (source.size > CLIPBOARD_IMAGE_MAX_SOURCE_BYTES) {
        throw new BridgeNativeVerbRefusedError(
          'native_media_too_large',
          `a provider item is ${source.size} bytes, over the ${CLIPBOARD_IMAGE_MAX_SOURCE_BYTES} read whole`
        )
      }
      destination.writeSync(source.bytesSync())
    }
  } catch (error) {
    // Remove the failed destination because callers never receive its URI.
    discardUnreturnedMediaFile(destination)
    throw error
  }
  return destination.uri
}

export function discardStagedMedia(uri: string): void {
  new FsFile(uri).delete()
}

export function nativeMediaDeviceDeps(registry: MediaHandleRegistry): NativeMediaDeps {
  return {
    registry,
    // Use remaining capacity, never zero (unlimited), to bound copies before registry admission.
    launchLibrary: ({ multiple, limit }) =>
      ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        base64: false,
        allowsMultipleSelection: multiple,
        ...(multiple ? { selectionLimit: limit, orderedSelection: true } : {}),
        ...agentReadableLibraryImageOptions()
      }),
    // DocumentPicker has no selection cap; enforce remaining room again before staging and minting.
    launchFiles: ({ multiple }) =>
      DocumentPicker.getDocumentAsync({ type: '*/*', multiple, copyToCacheDirectory: true }),
    readClipboardImage: () => Clipboard.getImageAsync({ format: 'png' }),
    stageBase64: (base64) => {
      const file = stagedMediaFile('png')
      file.create({ overwrite: true })
      try {
        file.writeSync(base64, { encoding: 'base64' })
      } catch (error) {
        discardUnreturnedMediaFile(file)
        throw error
      }
      return file.uri
    },
    openFile: (uri) => new FsFile(uri),
    ownsStagedUri: ownsStagedMediaUri,
    copyIntoCache: copyPickedMediaIntoCache,
    discard: discardStagedMedia
  }
}
