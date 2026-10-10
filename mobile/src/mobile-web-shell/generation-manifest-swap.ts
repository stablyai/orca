import {
  MobileWebBundleManifestReadSchema,
  type MobileWebBundleManifestRead
} from '../transport/mobile-web-bundle-reply-schemas'
import { joinUri } from './generation-cache-uri'
import type { GenerationFileSystem } from './generation-store-file-system'

/** The activation's manifest: a generation directory is an activation only once this is in it. */
export const MANIFEST_FILE_NAME = 'manifest.json'
/** The fresh manifest's name until the swap completes. Inside the generation directory, beside the
 *  assets it describes, because that is the only place a later read looks: a pending file under the
 *  host's staging tree would be swept away by the next launch instead of being finished. */
export const NEXT_MANIFEST_FILE_NAME = 'manifest-next.json'

/** Read back as loosely as it was accepted: reading a cached manifest strictly would make a field a
 *  newer desktop added a forced redownload on every launch. */
export function parseGenerationManifest(text: string | null): MobileWebBundleManifestRead | null {
  if (text === null) {
    return null
  }
  try {
    const parsed = MobileWebBundleManifestReadSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Replaces a generation's manifest with one that names the same assets.
 *
 * Three steps, because neither platform offers an atomic replace: `FileManager.moveItem` and
 * Kotlin's `moveTo` both refuse a destination that exists. The old manifest is never deleted before
 * the whole of the fresh one is on disk, and each of the three windows is one `settleManifestSwap`
 * finishes or discards — which is what makes an interruption cost nothing rather than cost the
 * generation, and a generation is a phone's whole workspace while its host is unreachable.
 */
export async function swapInFreshManifest(
  fs: GenerationFileSystem,
  directory: string,
  manifest: MobileWebBundleManifestRead
): Promise<void> {
  await fs.writeText(joinUri(directory, NEXT_MANIFEST_FILE_NAME), JSON.stringify(manifest))
  await fs.delete(joinUri(directory, MANIFEST_FILE_NAME))
  await fs.moveFile(
    joinUri(directory, NEXT_MANIFEST_FILE_NAME),
    joinUri(directory, MANIFEST_FILE_NAME)
  )
}

/** What a read found of a swap that may have been interrupted, and did about it. */
export type ManifestSwapSettlement =
  | 'nothing-pending'
  /** The pending manifest is whole and this build's, so it is the activation: the swap finished. */
  | 'adopted'
  /** Torn, or another bundle's. Only the fresh manifest is written before the old one is deleted,
   *  so a pending file that does not parse always has the old one still beside it. */
  | 'discarded'
  /** Pending and unsettleable. Nothing is deleted on this answer: the pending manifest may be the
   *  only one left, and the next read can still adopt it. */
  | 'unsettled'

export async function settleManifestSwap(
  fs: GenerationFileSystem,
  directory: string,
  buildId: string
): Promise<ManifestSwapSettlement> {
  const pending = joinUri(directory, NEXT_MANIFEST_FILE_NAME)
  try {
    if (!(await fs.fileExists(pending))) {
      return 'nothing-pending'
    }
    const manifest = parseGenerationManifest(await fs.readText(pending))
    if (manifest === null || manifest.buildId !== buildId) {
      await fs.delete(pending)
      return 'discarded'
    }
    await fs.delete(joinUri(directory, MANIFEST_FILE_NAME))
    await fs.moveFile(pending, joinUri(directory, MANIFEST_FILE_NAME))
    return 'adopted'
  } catch {
    return 'unsettled'
  }
}
