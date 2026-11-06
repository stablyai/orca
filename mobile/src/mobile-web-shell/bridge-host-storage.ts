import { subscribeMirroredKey } from '../storage/mirrored-storage-keys'
import { MARKDOWN_TEXT_SCALE_KEY } from '../storage/preferences'
import type { BridgeHost, BridgeHostOptions } from './bridge-host-contract'

export function trackPageStorageWrites(options: BridgeHostOptions) {
  let applyingPageWrite = false
  return {
    isApplyingPageWrite: () => applyingPageWrite,
    options: {
      ...options,
      onStorageWrite: (key: string, value: string | null) => {
        applyingPageWrite = true
        try {
          options.onStorageWrite(key, value)
        } finally {
          applyingPageWrite = false
        }
      }
    }
  }
}

export function subscribeMarkdownTextScale(
  mounted: { sessionId: string; host: BridgeHost } | null,
  sessionId: string | null
) {
  if (mounted === null || mounted.sessionId !== sessionId) {
    return
  }
  return subscribeMirroredKey(MARKDOWN_TEXT_SCALE_KEY, (value) => {
    mounted.host.publishStorageUpdate(MARKDOWN_TEXT_SCALE_KEY, value)
  })
}
