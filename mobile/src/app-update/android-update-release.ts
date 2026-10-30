import { z } from 'zod'

const RELEASE_PAGE =
  /^https:\/\/github\.com\/stablyai\/orca\/releases\/tag\/mobile-android-v(\d+\.\d+\.\d+)$/
const MAX_APK_BYTES = 512 * 1024 * 1024

const assetSchema = z.looseObject({
  name: z.literal('app-release.apk'),
  state: z.literal('uploaded'),
  size: z.number().int().positive().max(MAX_APK_BYTES),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  browser_download_url: z.string()
})
const releaseSchema = z.looseObject({
  draft: z.literal(false),
  tag_name: z.string(),
  assets: z.array(z.unknown())
})

export type AndroidUpdateAsset = {
  version: string
  url: string
  size: number
  sha256: string
}

export function androidUpdateVersion(releaseUrl: string): string | null {
  return RELEASE_PAGE.exec(releaseUrl)?.[1] ?? null
}

export function parseAndroidUpdateAsset(release: unknown, version: string): AndroidUpdateAsset {
  const parsed = releaseSchema.safeParse(release)
  if (!parsed.success || parsed.data.tag_name !== `mobile-android-v${version}`) {
    throw new Error('GitHub returned a different release. Open the release page to update.')
  }
  const candidates = parsed.data.assets.filter(
    (asset) => z.looseObject({ name: z.literal('app-release.apk') }).safeParse(asset).success
  )
  const asset = candidates.length === 1 ? assetSchema.safeParse(candidates[0]) : null
  const url = `https://github.com/stablyai/orca/releases/download/mobile-android-v${version}/app-release.apk`
  if (!asset?.success || asset.data.browser_download_url !== url) {
    throw new Error(
      'This release has no verified APK yet. Open the release page or try again later.'
    )
  }
  return { version, url, size: asset.data.size, sha256: asset.data.digest.slice(7) }
}

export async function loadAndroidUpdateAsset(
  releaseUrl: string,
  signal: AbortSignal
): Promise<AndroidUpdateAsset> {
  const version = androidUpdateVersion(releaseUrl)
  if (!version) {
    throw new Error('This is not an Orca Android release.')
  }
  const reply = await fetch(
    `https://api.github.com/repos/stablyai/orca/releases/tags/mobile-android-v${version}`,
    { signal }
  )
  if (!reply.ok) {
    throw new Error('Could not reach GitHub. Check your connection and try again.')
  }
  let release: unknown
  try {
    release = await reply.json()
  } catch {
    throw new Error('Could not read the release details. Try again or open the release page.')
  }
  return parseAndroidUpdateAsset(release, version)
}
