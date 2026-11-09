import type { MobileMediaSink } from './mobile-file-media-download'

export function createMobileMediaSink(_relativePath: string, mimeType: string): MobileMediaSink {
  let parts: Uint8Array<ArrayBuffer>[] = []
  let uri: string | null = null
  return {
    append: (bytes) => {
      parts.push(new Uint8Array(bytes))
    },
    finish: () => {
      uri = URL.createObjectURL(new Blob(parts, { type: mimeType }))
      parts = []
      return uri
    },
    dispose: () => {
      if (uri) {
        URL.revokeObjectURL(uri)
        uri = null
      }
      parts = []
    }
  }
}
