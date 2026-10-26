import { Directory, File, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import {
  MOBILE_SHARE_FILE_PREFIX,
  MOBILE_SHARE_FILE_STALE_AFTER_MS,
  type NativeFileShareDeps
} from './native-file-share'

export function nativeFileShareDeviceDeps(): NativeFileShareDeps {
  discardStaleShareFiles()
  return {
    writeCacheFile: (name, bytes) => {
      const file = new File(Paths.cache, name)
      file.create({ overwrite: true })
      file.write(bytes)
      return {
        uri: file.uri,
        delete: () => file.delete()
      }
    },
    shareFile: (file, options) => Sharing.shareAsync(file.uri, options)
  }
}

// Older sessions leave their hand-off behind when the viewer closes without telling us; sweep by the stamp in the name.
function discardStaleShareFiles(): void {
  try {
    const directory = new Directory(Paths.cache)
    if (!directory.exists) {
      return
    }
    const staleBefore = Date.now() - MOBILE_SHARE_FILE_STALE_AFTER_MS
    for (const entry of directory.list()) {
      if (!(entry instanceof File) || !entry.name.startsWith(MOBILE_SHARE_FILE_PREFIX)) {
        continue
      }
      const stamp = Number.parseInt(entry.name.slice(MOBILE_SHARE_FILE_PREFIX.length), 10)
      if (Number.isFinite(stamp) && stamp < staleBefore) {
        entry.delete()
      }
    }
  } catch (error) {
    console.warn('[web-shell] stale shared files could not be swept', error)
  }
}
