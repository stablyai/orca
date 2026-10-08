import { File, Paths, type FileHandle } from 'expo-file-system'
import type { MobileMediaSink } from './mobile-file-media-download'

export function createMobileMediaSink(relativePath: string, _mimeType: string): MobileMediaSink {
  const extension = relativePath.split('.').pop()?.toLowerCase() ?? 'bin'
  const file = new File(Paths.cache, `orca-preview-${Date.now()}-${Math.random()}.${extension}`)
  file.create()
  let handle: FileHandle | null
  try {
    handle = file.open()
  } catch (error) {
    file.delete()
    throw error
  }
  const close = (): void => {
    const openHandle = handle
    handle = null
    openHandle?.close()
  }
  return {
    append: (bytes) => {
      if (!handle) {
        throw new Error('Media preview was closed')
      }
      // Expo identifies typed arrays by constructor; Buffer subclasses are rejected.
      handle.writeBytes(new Uint8Array(bytes))
    },
    finish: () => {
      close()
      return file.uri
    },
    dispose: () => {
      try {
        close()
        if (file.exists) {
          file.delete()
        }
      } catch {
        // The OS can reclaim a cache file if deletion fails.
      }
    }
  }
}
