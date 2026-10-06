import { sha256 } from '@noble/hashes/sha256'
import { File, Paths } from 'expo-file-system'
import type { MobileFileMediaSink } from './mobile-file-media-handoff'

// The device half of the media handoff: the one module here that names expo-file-system,
// so the download loop over it stays testable without it (native-media's device split).

/** Why: a relative path is only unique inside its workspace, so the name keys on the workspace too. */
function shortPathHash(source: string): string {
  const digest = sha256(new TextEncoder().encode(source))
  return Array.from(digest.slice(0, 4), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** A cache name nothing else in this app writes, stable per downloaded source path. */
export function mediaHandoffCacheName(worktreeId: string, relativePath: string): string {
  const base = relativePath.split(/[\\/]/).pop() || 'download'
  const sanitized = base.replace(/[^A-Za-z0-9._-]/g, '_')
  return `orca-media-handoff-${shortPathHash(`${worktreeId}\n${relativePath}`)}-${sanitized}`
}

/** The sink + the uri the share sheet is handed once the download settles. */
export function mediaHandoffSinkFor(
  worktreeId: string,
  relativePath: string
): MobileFileMediaSink & { uri: string } {
  const file = new File(Paths.cache, mediaHandoffCacheName(worktreeId, relativePath))
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
