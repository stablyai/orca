import { describe, expect, it } from 'vitest'
import { androidUpdateVersion, parseAndroidUpdateAsset } from './android-update-release'

const version = '0.0.58'
const url = `https://github.com/stablyai/orca/releases/download/mobile-android-v${version}/app-release.apk`
const asset = {
  name: 'app-release.apk',
  state: 'uploaded',
  size: 132049829,
  digest: 'sha256:98a91cc9bc02031e12c1daf7f752c2a32ec85ba6d41c2de32847b1ab1712940e',
  browser_download_url: url
}
const release = {
  draft: false,
  prerelease: true,
  tag_name: `mobile-android-v${version}`,
  assets: [asset]
}

describe('Android APK release admission', () => {
  it('accepts Orca’s prerelease Android channel with an uploaded, checksummed APK', () => {
    expect(parseAndroidUpdateAsset(release, version)).toEqual({
      version,
      url,
      size: asset.size,
      sha256: asset.digest.slice(7)
    })
  })

  it.each([
    { ...asset, digest: null },
    { ...asset, digest: 'md5:abc' },
    { ...asset, size: 0 },
    { ...asset, size: 513 * 1024 * 1024 },
    { ...asset, state: 'starter' },
    { ...asset, browser_download_url: 'https://example.com/app-release.apk' },
    { ...asset, browser_download_url: `${url}?token=abc` },
    { ...asset, browser_download_url: url.replace('0.0.58', '0.0.57') }
  ])('rejects incomplete or substituted asset metadata: %j', (candidate) => {
    expect(() => parseAndroidUpdateAsset({ ...release, assets: [candidate] }, version)).toThrow()
  })

  it('rejects drafts, mismatched tags and ambiguous APKs', () => {
    for (const candidate of [
      { ...release, draft: true },
      { ...release, tag_name: 'mobile-android-v0.0.57' },
      { ...release, assets: [asset, asset] },
      { ...release, assets: [] }
    ]) {
      expect(() => parseAndroidUpdateAsset(candidate, version)).toThrow()
    }
  })

  it('only routes canonical Orca Android pages to the native updater', () => {
    const page = `https://github.com/stablyai/orca/releases/tag/mobile-android-v${version}`
    expect(androidUpdateVersion(page)).toBe(version)
    for (const value of [
      page.replace('stablyai', 'other'),
      `${page}/extra`,
      `${page}?q=x`,
      page.replace('https:', 'http:'),
      'https://apps.apple.com/app/orca'
    ]) {
      expect(androidUpdateVersion(value)).toBeNull()
    }
  })
})
