// Why GitHub: a release carries the build, its checksum list and sizes in one lookup.

import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import { getMainHttpClient } from '../network/http-client'

const SHA256 = /^[a-f0-9]{64}$/

const releaseSchema = lazyZodSchema(() =>
  z.object({
    tag_name: z.string(),
    assets: z.array(
      z.object({
        name: z.string(),
        size: z.number().int().positive(),
        browser_download_url: z.string().url(),
        digest: z.string().nullish()
      })
    )
  })
)

export type GithubReleaseAsset = { version: string; url: string; sha256: string; bytes: number }

/** `asset` in `repo`'s latest release, hashed by the release's checksum list; null when not published. */
export async function githubLatestReleaseAsset(input: {
  label: string
  repo: string
  /** The release's version from its tag; null for an unexpected tag, which keeps the last known release. */
  version: (tag: string) => string | null
  asset: string
  checksums: string
  signal?: AbortSignal
}): Promise<GithubReleaseAsset | null> {
  const { label, signal } = input
  const { fetch } = getMainHttpClient()
  const response = await fetch(`https://api.github.com/repos/${input.repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
    signal
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`${label} release lookup failed (${response.status})`)
  }
  const release = releaseSchema.parse(await response.json())
  const version = input.version(release.tag_name)
  if (!version) {
    throw new Error(`${label} release ${release.tag_name} has an unexpected tag`)
  }
  const asset = release.assets.find((candidate) => candidate.name === input.asset)
  const sums = release.assets.find((candidate) => candidate.name === input.checksums)
  if (!asset || !sums) {
    return null
  }
  const sumsResponse = await fetch(sums.browser_download_url, { signal })
  if (!sumsResponse.ok) {
    await sumsResponse.body?.cancel().catch(() => undefined)
    throw new Error(`${label} ${version} checksum lookup failed (${sumsResponse.status})`)
  }
  const listed = (await sumsResponse.text())
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === input.asset)?.[0]
    ?.toLowerCase()
  const digest = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7).toLowerCase() : null
  // GitHub's own digest, when present, must agree with the published list.
  if (!listed || !SHA256.test(listed) || (digest && digest !== listed)) {
    throw new Error(`${label} ${version} has no matching checksum for ${input.asset}`)
  }
  return { version, url: asset.browser_download_url, sha256: listed, bytes: asset.size }
}
