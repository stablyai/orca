import {
  MobileWebBundleManifestReadSchema,
  type MobileWebBundleManifestRead
} from '../transport/web-bundle/mobile-web-bundle-reply-schemas'
import { MANIFEST_FILE_NAME } from './generation-asset-path'
import { joinUri } from './generation-cache-uri'
import { parseJson } from './generation-host-order'
import type { StagedGeneration } from './generation-store'
import type { GenerationFileSystem } from './generation-store-file-system'

// Use the forward-compatible reader on disk too; newer desktop fields must not force redownload every launch.
export function parseGenerationManifest(text: string): MobileWebBundleManifestRead | null {
  const parsed = MobileWebBundleManifestReadSchema.safeParse(parseJson(text))
  return parsed.success ? parsed.data : null
}

// The build an earlier launch left waiting to commit: the host's only stage, complete because its manifest is written last.
export async function readWaitingStage(
  fs: GenerationFileSystem,
  hostKey: string,
  stagingUri: string
): Promise<StagedGeneration | null> {
  const staged = (await fs.list(stagingUri)).filter((entry) => entry.isDirectory)
  if (staged.length !== 1) {
    return null
  }
  const buildId = staged[0].name
  const directory = joinUri(stagingUri, buildId)
  const text = await fs.readText(joinUri(directory, MANIFEST_FILE_NAME)).catch(() => null)
  const manifest = text === null ? null : parseGenerationManifest(text)
  return manifest?.buildId === buildId ? { hostKey, buildId, directory, manifest } : null
}
