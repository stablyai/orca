import * as Clipboard from 'expo-clipboard'
import * as DocumentPicker from 'expo-document-picker'
import { File as FsFile, Paths } from 'expo-file-system'
import * as ImagePicker from 'expo-image-picker'
import type { MediaHandleRegistry } from '../mobile-web-shell/media-handle-registry'
import type { NativeMediaDeps } from './native-media'

/**
 * The device calls the media verbs actually make, and the only part of them a simulator has to
 * cover.
 *
 * Separated from the server because importing `expo-image-picker` imports React Native, so a
 * module that names it cannot be driven in a unit test at all — and because these seven lines are
 * where every platform difference lives: the library permission is iOS's to grant and Android's to
 * skip on a recent enough API, and both pickers are configured here to hand back a `file:` uri in
 * this app's own cache, which is what makes deleting one the shell's business.
 */
/**
 * Whether a picked uri is one this shell can size and delete.
 *
 * The scheme is the whole test. `expo-image-picker` always copies the selected asset into this
 * app's cache, and `expo-document-picker` does the same under `copyToCacheDirectory`, so both
 * answer `file:` on iOS and Android alike. Android is where the assumption could break: a provider
 * uri (`content://media/...`) is readable through a resolver and is not a file this app may unlink,
 * so a handle over one would never release.
 */
export function ownsStagedMediaUri(uri: string): boolean {
  return uri.startsWith('file:')
}

/** Deletes one staged file. Its own export because the registry needs it before a server exists. */
export function discardStagedMedia(uri: string): void {
  new FsFile(uri).delete()
}

export function nativeMediaDeviceDeps(registry: MediaHandleRegistry): NativeMediaDeps {
  return {
    registry,
    requestLibraryPermission: () => ImagePicker.requestMediaLibraryPermissionsAsync(),
    launchLibrary: ({ multiple }) =>
      ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        base64: false,
        allowsMultipleSelection: multiple,
        ...(multiple ? { selectionLimit: 0, orderedSelection: true } : {}),
        quality: 1
      }),
    launchFiles: ({ multiple }) =>
      DocumentPicker.getDocumentAsync({ type: '*/*', multiple, copyToCacheDirectory: true }),
    readClipboardImage: () => Clipboard.getImageAsync({ format: 'png' }),
    stageBase64: (base64) => {
      const file = new FsFile(Paths.cache, `orca-media-${Date.now()}-${Math.random()}.png`)
      file.create({ overwrite: true })
      file.write(base64, { encoding: 'base64' })
      return file.uri
    },
    openFile: (uri) => new FsFile(uri),
    ownsStagedUri: ownsStagedMediaUri,
    discard: discardStagedMedia
  }
}
