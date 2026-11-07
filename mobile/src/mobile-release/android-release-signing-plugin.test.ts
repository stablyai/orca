import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const plugin: {
  patchAppBuildGradle: (contents: string) => string
} = require('../../plugins/android-release-signing.js')
const { patchAppBuildGradle } = plugin

// The signing section of Expo's bare template app/build.gradle.
const TEMPLATE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}
`

describe('android-release-signing plugin', () => {
  it('signs release builds through the env-driven release config', () => {
    const patched = patchAppBuildGradle(TEMPLATE)

    expect(patched).toContain('storeFile file(orcaKeystorePath)')
    expect(patched).toContain('enableV3Signing = true')
    expect(patched).toContain('signingConfig orcaReleaseSigningConfig(signingConfigs)')
    expect(patched).toContain("System.getenv('ORCA_ANDROID_REQUIRE_RELEASE_SIGNING') == 'true'")
    // Debug builds keep the debug key; only the release build type changes.
    expect(patched.match(/signingConfig signingConfigs\.debug/g)).toHaveLength(1)
    expect(patched).not.toMatch(/storePassword '(?!android')/)
  })

  it('is idempotent across repeated prebuilds', () => {
    const once = patchAppBuildGradle(TEMPLATE)
    expect(patchAppBuildGradle(once)).toBe(once)
  })

  it('fails prebuild when the template no longer matches', () => {
    const changed = TEMPLATE.replace(
      /(release \{[\s\S]*?)signingConfig signingConfigs\.debug/,
      '$1signingConfig signingConfigs.other'
    )
    expect(() => patchAppBuildGradle(changed)).toThrow(/template changed/)
  })
})
