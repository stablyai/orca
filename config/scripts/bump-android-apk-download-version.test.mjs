import { describe, expect, it } from 'vitest'
import { bumpAndroidApkDownloadVersion } from './bump-android-apk-download-version.mjs'

const source = (version) =>
  [
    'import { getDownloadPlatforms } from "./downloadPlatforms";',
    '',
    `export const ANDROID_RELEASE_VERSION = "${version}";`,
    'export const ANDROID_DOWNLOAD_URL = `https://github.com/stablyai/orca/releases/download/mobile-android-v${ANDROID_RELEASE_VERSION}/app-release.apk`;',
    ''
  ].join('\n')

describe('bumpAndroidApkDownloadVersion', () => {
  it('rewrites only the version declaration', () => {
    expect(bumpAndroidApkDownloadVersion(source('0.0.52'), '0.0.55')).toEqual({
      previousVersion: '0.0.52',
      source: source('0.0.55')
    })
  })

  it('compares numerically, not as text', () => {
    expect(bumpAndroidApkDownloadVersion(source('0.0.9'), '0.0.10').source).toBe(source('0.0.10'))
  })

  it('leaves the same or a newer version in place', () => {
    expect(bumpAndroidApkDownloadVersion(source('0.0.55'), '0.0.55').source).toBe(source('0.0.55'))
    expect(bumpAndroidApkDownloadVersion(source('0.0.56'), '0.0.55').source).toBe(source('0.0.56'))
  })

  it('fails loudly when the declaration moved or the version is malformed', () => {
    expect(() => bumpAndroidApkDownloadVersion('export const OTHER = "0.0.1";', '0.0.55')).toThrow(
      'ANDROID_RELEASE_VERSION declaration not found'
    )
    expect(() => bumpAndroidApkDownloadVersion(source('0.0.52'), 'v0.0.55')).toThrow('x.y.z')
  })
})
