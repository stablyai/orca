import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  extractManifestAssetNames,
  getRequiredReleaseAssetNames,
  verifyRequiredReleaseAssets
} from './verify-release-required-assets.mjs'

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn(async () => body),
    text: vi.fn(async () => (typeof body === 'string' ? body : JSON.stringify(body)))
  }
}

function releaseWithAssets(tag, assetNames) {
  return {
    tag_name: tag,
    draft: true,
    prerelease: false,
    assets: assetNames.map((name, index) => ({
      id: index + 1,
      name,
      state: 'uploaded',
      size: 123
    }))
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getRequiredReleaseAssetNames', () => {
  it('includes both mac updater ZIP names for the tag version', () => {
    expect(getRequiredReleaseAssetNames('v1.4.27')).toEqual(
      expect.arrayContaining([
        'Orca-1.4.27-mac.zip',
        'Orca-1.4.27-mac.zip.blockmap',
        'Orca-1.4.27-arm64-mac.zip',
        'Orca-1.4.27-arm64-mac.zip.blockmap'
      ])
    )
  })

  it('includes the Linux RPM alongside the existing AppImage and deb names', () => {
    expect(getRequiredReleaseAssetNames('v1.4.27')).toEqual(
      expect.arrayContaining([
        'orca-linux.AppImage',
        'orca-ide_1.4.27_amd64.deb',
        'orca-ide-1.4.27.x86_64.rpm'
      ])
    )
  })
})

describe('extractManifestAssetNames', () => {
  it('extracts relative and absolute manifest asset names', () => {
    expect(
      extractManifestAssetNames(
        [
          'files:',
          '  - url: Orca-1.4.27-arm64-mac.zip',
          '  - url: https://example.com/downloads/orca-windows-setup.exe',
          'path: orca-linux.AppImage'
        ].join('\n')
      )
    ).toEqual(['Orca-1.4.27-arm64-mac.zip', 'orca-windows-setup.exe', 'orca-linux.AppImage'])
  })
})

describe('verifyRequiredReleaseAssets', () => {
  it('fails when a manifest-referenced asset has not been uploaded', async () => {
    const tag = 'v1.4.27'
    const required = getRequiredReleaseAssetNames(tag)
    const assets = required.filter((name) => name !== 'Orca-1.4.27-arm64-mac.zip')
    const release = releaseWithAssets(tag, assets)
    const latestMacAsset = release.assets.find((asset) => asset.name === 'latest-mac.yml')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([release]))
      .mockResolvedValueOnce(
        jsonResponse(
          [
            'version: 1.4.27',
            'files:',
            '  - url: Orca-1.4.27-arm64-mac.zip',
            '    sha512: test',
            'path: Orca-1.4.27-arm64-mac.zip'
          ].join('\n')
        )
      )
      .mockResolvedValue(jsonResponse('version: 1.4.27\n'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      verifyRequiredReleaseAssets({ repo: 'stablyai/orca', tag, token: 'token' })
    ).rejects.toThrow('Missing: Orca-1.4.27-arm64-mac.zip')
    expect(latestMacAsset).toBeTruthy()
  })
})
