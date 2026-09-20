import * as Clipboard from 'expo-clipboard'
import * as DocumentPicker from 'expo-document-picker'
import { File as FsFile, Paths } from 'expo-file-system'
import * as ImagePicker from 'expo-image-picker'
import { Platform } from 'react-native'
import type { MediaHandleRegistry } from '../mobile-web-shell/media-handle-registry'
import type { NativeMediaDeps } from './native-media'

/**
 * The device calls the media verbs actually make, and the only part of them a simulator has to
 * cover.
 *
 * Separated from the server because importing `expo-image-picker` imports React Native, so a
 * module that names it cannot be driven in a unit test at all — and because this is where every
 * platform difference lives: which uris a picker may answer, and which of them this shell can own.
 */
/**
 * Whether a picked uri is one this shell can size and delete.
 *
 * The scheme is the whole test. The usual answer from both pickers is `file:` — the iOS photo
 * picker copies what was selected, and `expo-document-picker` does under `copyToCacheDirectory` —
 * but it is not guaranteed. Android's `MediaHandler.readExtras` answers
 * `ImagePickerAsset(type = null, uri = uri.toString())` when `toMediaType` cannot resolve a MIME,
 * which is the provider's own `content://` uri, uncopied. That file is readable through a resolver
 * and is not one this app may unlink, so a handle over it would never release; `copyPickedMediaIntoCache`
 * is what turns it into one that can.
 */
export function ownsStagedMediaUri(uri: string): boolean {
  return uri.startsWith('file:')
}

/**
 * Whether a library pick has to ask for the media-library permission first.
 *
 * Read from expo-image-picker 55.0.24 rather than from the docs. Neither platform's
 * `launchImageLibraryAsync` gates on a permission: `launchCameraAsync` calls
 * `ensureCameraPermissionsAreGranted` / `hasGrantedPermission` and the library arm goes straight
 * to its contract. On Android `getMediaLibraryPermissions` answers an empty array from API 33
 * (TIRAMISU), so the request prompts nothing and always resolves granted; below 33 it asks for
 * `READ_EXTERNAL_STORAGE` and `WRITE_EXTERNAL_STORAGE`, which the system picker never reads — and
 * a denial there would refuse a pick the OS would have completed. So Android does not ask.
 *
 * iOS still does, because the prompt inside `pick` is what ruling 6 asked the shell to own and the
 * photo-library dialog is a real thing a user sees there. Noted for whoever revisits it: with
 * `allowsEditing: false` the iOS path is `launchMultiSelectPicker`, a `PHPickerViewController`,
 * which also opens without authorization — so this request is the ruling's, not the SDK's.
 */
export function libraryPickNeedsPermission(platform: string): boolean {
  return platform === 'ios'
}

/** A cache file name nothing else in this app writes, unique per staged item. */
function stagedMediaFile(extension: string): FsFile {
  return new FsFile(Paths.cache, `orca-media-${Date.now()}-${Math.random()}.${extension}`)
}

/**
 * Copies what a uri names into this shell's cache and answers the copy's uri.
 *
 * Through `bytes()` rather than `copy()`: `FileSystemPath.copy` goes to `javaFile.copyRecursively`,
 * which is a `java.io.File` and has nothing to open for a provider uri, while the read path goes
 * through the unified file and does. The whole item is held in memory for the length of the copy,
 * which is bounded by the staging ceiling the caller checks right after.
 */
export function copyPickedMediaIntoCache(uri: string): string {
  const destination = stagedMediaFile('bin')
  destination.create({ overwrite: true })
  try {
    destination.write(new FsFile(uri).bytesSync())
  } catch (error) {
    // The empty file this just created is nobody's otherwise: the caller never learns its name.
    try {
      destination.delete()
    } catch {
      // Best effort; the cache is the OS's to reclaim.
    }
    throw error
  }
  return destination.uri
}

/** Deletes one staged file. Its own export because the registry needs it before a server exists. */
export function discardStagedMedia(uri: string): void {
  new FsFile(uri).delete()
}

export function nativeMediaDeviceDeps(registry: MediaHandleRegistry): NativeMediaDeps {
  return {
    registry,
    requestLibraryPermission: () =>
      libraryPickNeedsPermission(Platform.OS)
        ? ImagePicker.requestMediaLibraryPermissionsAsync()
        : Promise.resolve({ granted: true }),
    // `selectionLimit` is the registry's remaining room, never 0: zero means unlimited to the OS
    // picker, and an unlimited selection is one the registry refuses after the OS has already
    // copied every asset into the cache. `pick` refuses an empty room before reaching here.
    launchLibrary: ({ multiple, limit }) =>
      ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        base64: false,
        allowsMultipleSelection: multiple,
        ...(multiple ? { selectionLimit: limit, orderedSelection: true } : {}),
        quality: 1
      }),
    // `getDocumentAsync` takes no selection limit, so the room is only the up-front refusal here;
    // a multi-select past it is still refused by `mint`, which is the bound that cannot be skipped.
    launchFiles: ({ multiple }) =>
      DocumentPicker.getDocumentAsync({ type: '*/*', multiple, copyToCacheDirectory: true }),
    readClipboardImage: () => Clipboard.getImageAsync({ format: 'png' }),
    stageBase64: (base64) => {
      const file = stagedMediaFile('png')
      file.create({ overwrite: true })
      file.write(base64, { encoding: 'base64' })
      return file.uri
    },
    openFile: (uri) => new FsFile(uri),
    ownsStagedUri: ownsStagedMediaUri,
    copyIntoCache: copyPickedMediaIntoCache,
    discard: discardStagedMedia
  }
}
