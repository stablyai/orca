import { Directory, File, Paths } from 'expo-file-system'

/** Root of the whole mobile-web cache, one level under the OS cache directory. */
export const MOBILE_WEB_CACHE_DIRECTORY_NAME = 'mobile-web'

export type GenerationDirectoryEntry = {
  readonly name: string
  readonly isDirectory: boolean
}

/**
 * Everything the generation store does to disk, as plain `file://` uris.
 *
 * The store never imports `expo-file-system`, so its tests run the real write ordering, failure and
 * interruption paths against an in-memory tree instead of a simulator.
 */
export type GenerationFileSystem = {
  readonly rootUri: string
  /** Empty when the directory is missing, so a first run is not a special case. */
  list(uri: string): Promise<readonly GenerationDirectoryEntry[]>
  /** Creates intermediate directories and succeeds when the directory already exists. */
  createDirectory(uri: string): Promise<void>
  /** Both writes create intermediate directories. */
  writeBytes(uri: string, bytes: Uint8Array): Promise<void>
  writeText(uri: string, text: string): Promise<void>
  /** Null only when the file is missing. A read that fails throws, because "absent" and "could not
   *  be read" lead the store to opposite decisions about deleting the cache. */
  readText(uri: string): Promise<string | null>
  fileExists(uri: string): Promise<boolean>
  /** Recursive, and a no-op when the path is missing. */
  delete(uri: string): Promise<void>
  /** Renames a directory. The destination must not exist: expo moves a directory *into* an existing
   *  destination rather than over it. */
  moveDirectory(fromUri: string, toUri: string): Promise<void>
  /**
   * Renames a file over the destination, which may already exist.
   *
   * Not an atomic replace, because expo exposes none: `FileManager.moveItem` and Kotlin's
   * `moveTo` both refuse a destination that exists, so the adapter deletes it first. A failure
   * therefore leaves either the old file or none — never a half-written one, which is what the
   * store needs, since a manifest that cannot be parsed and one that is absent both read back as
   * "no activation" and redownload.
   */
  moveFile(fromUri: string, toUri: string): Promise<void>
}

const FILE_URI_PREFIX = 'file://'

/**
 * The `file://` uri the store works in, as the absolute path the native shell view requires.
 *
 * The two sides speak different dialects of the same location: `expo-file-system` hands out uris,
 * and both native loaders refuse anything that does not start with `/`. Percent-decoded because a
 * uri escapes what a path spells literally, and left alone when it is already a path so a caller
 * cannot double-decode one.
 */
export function generationDirectoryPath(uri: string): string {
  if (!uri.startsWith(FILE_URI_PREFIX)) {
    return uri
  }
  return decodeURIComponent(uri.slice(FILE_URI_PREFIX.length))
}

export function createExpoGenerationFileSystem(): GenerationFileSystem {
  return {
    rootUri: new Directory(Paths.cache, MOBILE_WEB_CACHE_DIRECTORY_NAME).uri,
    async list(uri) {
      const directory = new Directory(uri)
      if (!directory.exists) {
        return []
      }
      return directory
        .list()
        .map((entry) => ({ name: entry.name, isDirectory: entry instanceof Directory }))
    },
    async createDirectory(uri) {
      new Directory(uri).create({ intermediates: true, idempotent: true })
    },
    async writeBytes(uri, bytes) {
      const file = new File(uri)
      file.create({ intermediates: true, overwrite: true })
      file.write(bytes)
    },
    async writeText(uri, text) {
      const file = new File(uri)
      file.create({ intermediates: true, overwrite: true })
      file.write(text)
    },
    async readText(uri) {
      const file = new File(uri)
      // The throw is deliberate: iOS data protection and I/O errors reach the store as failures
      // rather than as a missing file.
      return file.exists ? await file.text() : null
    },
    async fileExists(uri) {
      return new File(uri).exists
    },
    async delete(uri) {
      const directory = new Directory(uri)
      if (directory.exists) {
        directory.delete()
        return
      }
      const file = new File(uri)
      if (file.exists) {
        file.delete()
      }
    },
    async moveDirectory(fromUri, toUri) {
      new Directory(fromUri).move(new Directory(toUri))
    },
    async moveFile(fromUri, toUri) {
      const destination = new File(toUri)
      if (destination.exists) {
        destination.delete()
      }
      new File(fromUri).move(destination)
    }
  }
}
