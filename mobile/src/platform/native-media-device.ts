import * as Clipboard from 'expo-clipboard'
import * as DocumentPicker from 'expo-document-picker'
import { File as FsFile, Paths } from 'expo-file-system'
import * as ImagePicker from 'expo-image-picker'
import type { MediaHandleRegistry } from '../mobile-web-shell/media-handle-registry'
import type { NativeMediaDeps } from './native-media'

// Isolate native imports so handlers can be tested with injected device calls.
// Android may return an uncopied content: URI; copy it into cache before minting a handle whose release deletes the file.
export function ownsStagedMediaUri(uri: string): boolean {
  return uri.startsWith('file:')
}

function stagedMediaFile(extension: string): FsFile {
  return new FsFile(Paths.cache, `orca-media-${Date.now()}-${Math.random()}.${extension}`)
}

function discardUnreturnedMediaFile(file: FsFile): void {
  try {
    file.delete()
  } catch {
    // Best effort; the cache is the OS's to reclaim.
  }
}

// Use bytesSync(): Expo copy/open/stream paths require javaFile and reject content: URIs. The caller must weigh first because this read holds the whole file in memory.
export function copyPickedMediaIntoCache(uri: string): string {
  const destination = stagedMediaFile('bin')
  destination.create({ overwrite: true })
  try {
    destination.write(new FsFile(uri).bytesSync())
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
        quality: 1
      }),
    // DocumentPicker has no selection cap; enforce remaining room again before staging and minting.
    launchFiles: ({ multiple }) =>
      DocumentPicker.getDocumentAsync({ type: '*/*', multiple, copyToCacheDirectory: true }),
    readClipboardImage: () => Clipboard.getImageAsync({ format: 'png' }),
    stageBase64: (base64) => {
      const file = stagedMediaFile('png')
      file.create({ overwrite: true })
      try {
        file.write(base64, { encoding: 'base64' })
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
