import { compareAppVersions } from '../../../src/shared/app-version'
import type { AppUpdateCheckResult, AppUpdateSource } from './app-update-source'
import { isNewerReleaseVersion } from './app-update-source'

const REPO_API = 'https://api.github.com/repos/stablyai/orca'
const TAG_PREFIX = 'mobile-android-v'
// Why: the release workflow pushes the tag before the APK build, so a failed build leaves a
// tag with no release; probe a few older candidates, bounded like the desktop's manifest probe.
const MAX_RELEASE_PROBES = 3

type Fetch = typeof fetch

/** Newest-first versions from the tag refs GitHub returns for the mobile-android prefix. */
export function parseMobileAndroidTagVersions(refs: unknown): string[] {
  if (!Array.isArray(refs)) {
    throw new Error('tag refs reply is not a list')
  }
  const versions: string[] = []
  for (const entry of refs) {
    const ref: unknown =
      typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'ref') : null
    if (typeof ref === 'string' && ref.startsWith(`refs/tags/${TAG_PREFIX}`)) {
      versions.push(ref.slice(`refs/tags/${TAG_PREFIX}`.length))
    }
  }
  return versions
}

/** The release page when the tag has a published release carrying an APK, else null. */
export function installableReleaseUrl(release: unknown): string | null {
  if (typeof release !== 'object' || release === null) {
    return null
  }
  const draft: unknown = Reflect.get(release, 'draft')
  const htmlUrl: unknown = Reflect.get(release, 'html_url')
  const assets: unknown = Reflect.get(release, 'assets')
  const hasApk =
    Array.isArray(assets) &&
    assets.some((asset: unknown) => {
      const name: unknown =
        typeof asset === 'object' && asset !== null ? Reflect.get(asset, 'name') : null
      return typeof name === 'string' && name.endsWith('.apk')
    })
  return draft === false && hasApk && typeof htmlUrl === 'string' ? htmlUrl : null
}

export function createGithubReleaseUpdateSource(fetchImpl: Fetch): AppUpdateSource {
  return {
    async check(installedVersion, signal): Promise<AppUpdateCheckResult> {
      const refsReply = await fetchImpl(`${REPO_API}/git/matching-refs/tags/${TAG_PREFIX}`, {
        signal
      })
      if (!refsReply.ok) {
        throw new Error(`tag refs HTTP ${refsReply.status}`)
      }
      const candidates = parseMobileAndroidTagVersions(await refsReply.json())
        .filter((version) => isNewerReleaseVersion(version, installedVersion))
        .sort((left, right) => compareAppVersions(right, left))
        .slice(0, MAX_RELEASE_PROBES)
      for (const version of candidates) {
        const releaseReply = await fetchImpl(
          `${REPO_API}/releases/tags/${encodeURIComponent(`${TAG_PREFIX}${version}`)}`,
          { signal }
        )
        if (releaseReply.status === 404) {
          continue
        }
        if (!releaseReply.ok) {
          throw new Error(`release HTTP ${releaseReply.status}`)
        }
        const url = installableReleaseUrl(await releaseReply.json())
        if (url) {
          return { kind: 'available', version, url }
        }
      }
      return { kind: 'current' }
    }
  }
}

export const githubReleaseUpdateSource = createGithubReleaseUpdateSource((input, init) =>
  fetch(input, init)
)
