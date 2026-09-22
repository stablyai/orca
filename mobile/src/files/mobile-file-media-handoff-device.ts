import { File, Paths } from 'expo-file-system'
import type { MobileFileMediaSink } from './mobile-file-media-handoff'

// The device half of the media handoff: the one module here that names expo-file-system,
// so the download loop over it stays testable without it (native-media's device split).

/** A cache name nothing else in this app writes, stable per downloaded basename. */
export function mediaHandoffCacheName(relativePath: string): string {
  const base = relativePath.split(/[\\/]/).pop() || 'download'
  return `orca-media-handoff-${base.replace(/[^A-Za-z0-9._-]/g, '_')}`
}

/** The sink + the uri the share sheet is handed once the download settles. */
export function mediaHandoffSinkFor(relativePath: string): MobileFileMediaSink & { uri: string } {
  const file = new File(Paths.cache, mediaHandoffCacheName(relativePath))
  return {
    uri: file.uri,
    open() {
      if (file.exists) {
        file.delete()
      }
    },
    appendBase64(base64: string) {
      file.write(base64, { encoding: 'base64', append: true })
    },
    discard() {
      if (file.exists) {
        file.delete()
      }
    }
  }
}
