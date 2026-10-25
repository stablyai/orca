import { useMemo } from 'react'
import {
  readStagedMediaItem,
  releaseAllStagedMedia
} from '../mobile-web-shell/bridge/staged-media-bytes'
import { useNativeVerbs } from '../mobile-web-shell/bridge/use-native-verbs'
import type { ClipboardImage, ClipboardReader, ClipboardWriter } from './clipboard'

// Use native clipboard verbs: navigator.clipboard requires a secure context unavailable under iOS’s custom scheme. Ungranted writes reject for callers to report.
export function useClipboardWriter(): ClipboardWriter {
  const verbs = useNativeVerbs()

  return useMemo(
    () => ({
      writeText: async (value) => {
        if (!(await verbs.writeClipboardText(value))) {
          throw new Error('the clipboard did not accept this text')
        }
      }
    }),
    [verbs]
  )
}

// Stage/chunk/release images to stay below reply caps; clipboard.read accepts text only. Preserve native data/size and empty-versus-refused outcomes.
// Probe from grants without reading: the shell has no availability verb and iOS reads prompt for consent. Read-only grants must still enable paste.
export function useClipboardReader(): ClipboardReader {
  const verbs = useNativeVerbs()

  return useMemo(
    () => ({
      readText: async () => await verbs.readClipboardText(),
      readImage: async (): Promise<ClipboardImage | null> => {
        const picked = await verbs.pickMedia('clipboard', false)
        const [image] = picked
        if (image === undefined) {
          return null
        }
        try {
          return {
            data: await readStagedMediaItem(verbs, image),
            // Unknown dimensions stay zero so existing resize/upload limits decide instead of inventing a raster size.
            size: { width: image.width ?? 0, height: image.height ?? 0 }
          }
        } finally {
          await releaseAllStagedMedia(verbs, picked)
        }
      },
      contents: async () =>
        await Promise.resolve({ text: verbs.canReadClipboardText, image: verbs.canPickMedia })
    }),
    [verbs]
  )
}
