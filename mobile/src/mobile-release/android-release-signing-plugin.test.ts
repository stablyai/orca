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
  it('fails prebuild when the template no longer matches', () => {
    const changed = TEMPLATE.replace(
      /(release \{[\s\S]*?)signingConfig signingConfigs\.debug/,
      '$1signingConfig signingConfigs.other'
    )
    expect(() => patchAppBuildGradle(changed)).toThrow(/template changed/)
  })
})
