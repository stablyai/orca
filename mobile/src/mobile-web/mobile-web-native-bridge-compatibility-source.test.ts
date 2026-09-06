import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_ASSET_METADATA_BY_EXTENSION,
  MOBILE_WEB_MAX_ASSET_BYTES
} from '../../../src/shared/mobile-web/manifest-contract'

const iosStoreSource = readFileSync(
  new URL('../../packages/expo-mobile-web-shell/ios/MobileWebPackageStore.swift', import.meta.url),
  'utf8'
)
const iosModuleSource = readFileSync(
  new URL(
    '../../packages/expo-mobile-web-shell/ios/ExpoMobileWebShellModule.swift',
    import.meta.url
  ),
  'utf8'
)
const androidStoreSource = readFileSync(
  new URL(
    '../../packages/expo-mobile-web-shell/android/src/main/java/expo/modules/mobilewebshell/MobileWebPackageStore.kt',
    import.meta.url
  ),
  'utf8'
)
const androidModuleSource = readFileSync(
  new URL(
    '../../packages/expo-mobile-web-shell/android/src/main/java/expo/modules/mobilewebshell/ExpoMobileWebShellModule.kt',
    import.meta.url
  ),
  'utf8'
)

describe('mobile web native bridge compatibility', () => {
  it('requires the current bridge version when opening cached packages', () => {
    expect(iosModuleSource).toContain(
      '(hostIdentity: String, buildId: String?, bridgeVersion: Int)'
    )
    expect(iosModuleSource).toContain('bridgeVersion: bridgeVersion')
    expect(androidModuleSource).toContain('bridgeVersion: Int')
    expect(androidModuleSource).toContain(
      'packageStore.openSession(hostIdentity, buildId, bridgeVersion)'
    )
  })

  it('enforces both manifest bounds on initial open and recovery', () => {
    expect(iosStoreSource.match(/requireCompatibleBridge/g)).toHaveLength(3)
    expect(iosStoreSource).toContain('bridgeVersion >= manifest.bridgeMinimum')
    expect(iosStoreSource).toContain('bridgeVersion <= manifest.bridgeTestedThrough')
    expect(androidStoreSource.match(/requireCompatibleBridge/g)).toHaveLength(3)
    expect(androidStoreSource).toContain(
      'bridgeVersion in manifest.bridgeMinimum..manifest.bridgeTestedThrough'
    )
  })

  it('keeps native package asset limits aligned with the shared manifest', () => {
    expect(MOBILE_WEB_MAX_ASSET_BYTES).toBe(10 * 1024 * 1024)
    expect(iosStoreSource).toContain('private let assetByteLimit = 10 * 1024 * 1024')
    expect(iosStoreSource).toContain('length <= assetByteLimit')
    expect(androidStoreSource).toContain('private const val ASSET_BYTE_LIMIT = 10 * 1024 * 1024')
    expect(androidStoreSource).toContain('length in 1..ASSET_BYTE_LIMIT')
  })

  it('keeps native extension, MIME, and role maps aligned with the shared manifest', () => {
    const expected = Object.entries(MOBILE_WEB_ASSET_METADATA_BY_EXTENSION).map(
      ([extension, metadata]) => ({
        extension,
        contentType: metadata.contentType,
        role: metadata.role
      })
    )

    expect(nativeAssetMetadata(iosStoreSource, 'assetMetadataByExtension', 'swift')).toEqual(
      expected
    )
    expect(
      nativeAssetMetadata(androidStoreSource, 'ASSET_METADATA_BY_EXTENSION', 'kotlin')
    ).toEqual(expected)
  })
})

function nativeAssetMetadata(
  source: string,
  declaration: string,
  language: 'swift' | 'kotlin'
): { extension: string; contentType: string; role: string }[] {
  const start = source.indexOf(declaration)
  const end = source.indexOf(language === 'swift' ? '\n]\n' : '\n)\n', start)
  if (start === -1 || end === -1) {
    return []
  }
  const pattern =
    language === 'swift'
      ? /^\s*"([^"]+)": \("([^"]+)", "([^"]+)"\),?$/gm
      : /^\s*"([^"]+)" to \("([^"]+)" to "([^"]+)"\),?$/gm
  return [...source.slice(start, end).matchAll(pattern)].map((match) => ({
    extension: match[1]!,
    contentType: match[2]!,
    role: match[3]!
  }))
}
