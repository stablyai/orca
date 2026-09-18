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
  /** Null when the file is missing or unreadable, which the store treats the same way. */
  readText(uri: string): Promise<string | null>
  fileExists(uri: string): Promise<boolean>
  /** Recursive, and a no-op when the path is missing. */
  delete(uri: string): Promise<void>
  /** Renames a directory. The destination must not exist: expo moves a directory *into* an existing
   *  destination rather than over it. */
  moveDirectory(fromUri: string, toUri: string): Promise<void>
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
      if (!file.exists) {
        return null
      }
      try {
        return await file.text()
      } catch {
        return null
      }
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
    }
  }
}
