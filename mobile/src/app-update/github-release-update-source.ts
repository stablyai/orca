import { z } from 'zod'
import { compareAppVersions } from '../../../src/shared/app-version'
import type { AppUpdateCheckResult, AppUpdateSource } from './app-update-source'
import { isNewerReleaseVersion } from './app-update-source'

const REPO_API = 'https://api.github.com/repos/stablyai/orca'
// Use tag refs: newest-first release/Atom windows can fill with desktop releases and hide mobile updates; Android releases all carry prerelease flag.
/** dev.orca.app releases: Google's Play-signed universal APK. */
export const ANDROID_RELEASE_TAG_PREFIX = 'android-v'
/** com.stably.orca.mobile releases, signed with the Expo debug key. */
export const RETIRED_ANDROID_RELEASE_TAG_PREFIX = 'mobile-android-v'
// Probe bounded older candidates: workflow tags before APK build, so failed build can leave unpublished tag.
const MAX_RELEASE_PROBES = 3

type Fetch = typeof fetch

const tagRefsSchema = z.array(z.looseObject({ ref: z.string() }))
const installableReleaseSchema = z.looseObject({
  draft: z.literal(false),
  html_url: z.string(),
  assets: z.array(z.looseObject({ name: z.string(), browser_download_url: z.string().optional() }))
})

export type InstallableRelease = {
  readonly version: string
  readonly pageUrl: string
  readonly apkUrl: string | null
}

/** Versions named by the tag refs GitHub returns for the prefix. */
export function parseTagVersions(refs: unknown, tagPrefix: string): string[] {
  const prefix = `refs/tags/${tagPrefix}`
  return tagRefsSchema
    .parse(refs)
    .filter(({ ref }) => ref.startsWith(prefix))
    .map(({ ref }) => ref.slice(prefix.length))
}

function installableRelease(version: string, release: unknown): InstallableRelease | null {
  const parsed = installableReleaseSchema.safeParse(release)
  const apk = parsed.success
    ? parsed.data.assets.find((asset) => asset.name.endsWith('.apk'))
    : null
  return parsed.success && apk
    ? { version, pageUrl: parsed.data.html_url, apkUrl: apk.browser_download_url ?? null }
    : null
}

/** The newest published release under the tag prefix that carries an APK, or null. */
export async function findNewestInstallableRelease(
  fetchImpl: Fetch,
  tagPrefix: string,
  signal: AbortSignal,
  isCandidate: (version: string) => boolean = () => true
): Promise<InstallableRelease | null> {
  const refsReply = await fetchImpl(`${REPO_API}/git/matching-refs/tags/${tagPrefix}`, { signal })
  if (!refsReply.ok) {
    throw new Error(`tag refs HTTP ${refsReply.status}`)
  }
  const candidates = parseTagVersions(await refsReply.json(), tagPrefix)
    .filter(isCandidate)
    .sort((left, right) => compareAppVersions(right, left))
    .slice(0, MAX_RELEASE_PROBES)
  for (const version of candidates) {
    const releaseReply = await fetchImpl(
      `${REPO_API}/releases/tags/${encodeURIComponent(`${tagPrefix}${version}`)}`,
      { signal }
    )
    if (releaseReply.status === 404) {
      continue
    }
    if (!releaseReply.ok) {
      throw new Error(`release HTTP ${releaseReply.status}`)
    }
    const release = installableRelease(version, await releaseReply.json())
    if (release) {
      return release
    }
  }
  return null
}

export function createGithubReleaseUpdateSource(
  fetchImpl: Fetch,
  tagPrefix: string
): AppUpdateSource {
  return {
    async check(installedVersion, signal): Promise<AppUpdateCheckResult> {
      const release = await findNewestInstallableRelease(fetchImpl, tagPrefix, signal, (version) =>
        isNewerReleaseVersion(version, installedVersion)
      )
      return release
        ? { kind: 'available', version: release.version, url: release.pageUrl }
        : { kind: 'current' }
    }
  }
}
