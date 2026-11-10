import { Directory, File } from 'expo-file-system'
import { Platform } from 'react-native'

export type GenerationDirectoryEntry = {
  readonly name: string
  readonly isDirectory: boolean
}

export type GenerationFileListing = {
  readonly name: string
  readonly size: number
  // Milliseconds since the epoch; null when the platform can't report it.
  readonly modificationTime: number | null
}

// Keep the store independent of Expo so tests exercise real interruption/write ordering through this file:// port.
export type GenerationFileSystem = {
  readonly rootUri: string
  // Missing directories list as empty.
  list(uri: string): Promise<readonly GenerationDirectoryEntry[]>
  // Create parents and tolerate an existing directory.
  createDirectory(uri: string): Promise<void>
  // Both writes create parents.
  writeBytes(uri: string, bytes: Uint8Array): Promise<void>
  writeText(uri: string, text: string): Promise<void>
  // Return null only for absence; unreadable files must throw so transient I/O cannot make the store delete a valid cache.
  readText(uri: string): Promise<string | null>
  readBytes(uri: string): Promise<Uint8Array | null>
  fileExists(uri: string): Promise<boolean>
  fileSize(uri: string): Promise<number | null>
  // Files only, with the size and mtime the listing already holds (a stat per file costs a JSI object each).
  listFiles(uri: string): Promise<readonly GenerationFileListing[]>
  // One native call: total bytes under the directory and its entry count, with no JSI object per file.
  summarizeDirectory(uri: string): Promise<{ readonly size: number; readonly entryCount: number }>
  // Create destination parents; require an absent destination on both platforms and throw for unavailable sources.
  copyFile(fromUri: string, toUri: string): Promise<void>
  // Delete recursively; missing paths are a no-op.
  delete(uri: string): Promise<void>
  // Require an absent destination: Expo moves into existing directories instead of replacing them.
  moveDirectory(fromUri: string, toUri: string): Promise<void>
  // Require an absent destination: SDK 55 File.move has no overwrite option.
  moveFile(fromUri: string, toUri: string): Promise<void>
}

const FILE_URI_PREFIX = 'file://'

// Native loaders require absolute paths; decode file:// URIs but leave paths untouched to avoid double-decoding.
export function generationDirectoryPath(uri: string): string {
  if (!uri.startsWith(FILE_URI_PREFIX)) {
    return uri
  }
  return decodeURIComponent(uri.slice(FILE_URI_PREFIX.length))
}

export function createExpoGenerationFileSystem(rootUri: string): GenerationFileSystem {
  return {
    rootUri,
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
      // Propagate I/O and iOS data-protection failures instead of treating an unreadable file as absent.
      return file.exists ? await file.text() : null
    },
    async readBytes(uri) {
      const file = new File(uri)
      return file.exists ? await file.bytes() : null
    },
    async fileExists(uri) {
      return new File(uri).exists
    },
    async fileSize(uri) {
      const file = new File(uri)
      return file.exists ? file.size : null
    },
    async listFiles(uri) {
      const directory = new Directory(uri)
      if (!directory.exists) {
        return []
      }
      return directory
        .list()
        .flatMap((entry) =>
          entry instanceof File
            ? [{ name: entry.name, size: entry.size, modificationTime: entry.modificationTime }]
            : []
        )
    },
    async summarizeDirectory(uri) {
      const info = new Directory(uri).info()
      return { size: info.size ?? 0, entryCount: info.files?.length ?? 0 }
    },
    async copyFile(fromUri, toUri) {
      const target = new File(toUri)
      // iOS copies only into an existing directory.
      target.parentDirectory.create({ intermediates: true, idempotent: true })
      new File(fromUri).copy(target)
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
      const from = new Directory(fromUri)
      // Below API 26, Expo 55's move copies a directory without its contents; its copy is recursive.
      if (Platform.OS === 'android' && Number(Platform.Version) < 26) {
        const to = new Directory(toUri)
        try {
          from.copy(to)
        } catch (error) {
          // Readers trust a generation by its manifest, so a failed copy must leave no partial tree.
          if (to.exists) {
            to.delete()
          }
          throw error
        }
        from.delete()
        return
      }
      from.move(new Directory(toUri))
    },
    async moveFile(fromUri, toUri) {
      new File(fromUri).move(new File(toUri))
    }
  }
}
