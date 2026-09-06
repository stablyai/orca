import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const { addInspectableReleaseOptIn } = createRequire(import.meta.url)(
  '../../plugins/android-inspectable-release.js'
)

const inspectionPolicySource = readFileSync(
  new URL(
    '../../packages/expo-mobile-web-shell/android/src/main/java/expo/modules/mobilewebshell/MobileWebInspectionPolicy.kt',
    import.meta.url
  ),
  'utf8'
)
const probeSource = readFileSync(
  new URL(
    '../../packages/expo-mobile-web-shell/android/src/main/java/expo/modules/mobilewebshell/MobileWebDebugIsolationProbe.kt',
    import.meta.url
  ),
  'utf8'
)
const shellGradleSource = readFileSync(
  new URL('../../packages/expo-mobile-web-shell/android/build.gradle', import.meta.url),
  'utf8'
)

const releaseGradle = [
  '    buildTypes {',
  '        debug {',
  '            signingConfig signingConfigs.debug',
  '        }',
  '        release {',
  '            signingConfig signingConfigs.debug',
  '        }',
  '    }',
  ''
].join('\n')

describe('Android inspectable-release opt-in', () => {
  it('still requires the OS debuggable flag before enabling DevTools', () => {
    expect(inspectionPolicySource).toContain(
      'val isDebuggable = applicationFlags and ApplicationInfo.FLAG_DEBUGGABLE != 0'
    )
    expect(inspectionPolicySource).toContain(
      'return isDebuggable && (isDebugBuild || isInspectableRelease)'
    )
    expect(inspectionPolicySource).toContain('isDebugBuild: Boolean = BuildConfig.DEBUG')
    expect(inspectionPolicySource).toContain(
      'isInspectableRelease: Boolean = BuildConfig.ORCA_INSPECTABLE_RELEASE'
    )
  })

  it('defaults the shell build config field to false', () => {
    expect(shellGradleSource).toContain("buildConfigField 'boolean', 'ORCA_INSPECTABLE_RELEASE'")
    expect(shellGradleSource).toContain(
      "(findProperty('orcaInspectableRelease') ?: 'false').toBoolean().toString()"
    )
  })

  it('makes only the release variant debuggable, and only when the property is set', () => {
    const patched = addInspectableReleaseOptIn(releaseGradle)
    const releaseBlock = patched.slice(patched.indexOf('        release {'))

    expect(releaseBlock).toContain(
      "debuggable = (findProperty('orcaInspectableRelease') ?: 'false').toBoolean()"
    )
    expect(patched.slice(0, patched.indexOf('        release {'))).not.toContain('debuggable')
    expect(addInspectableReleaseOptIn(patched)).toBe(patched)
  })

  it('fails loudly when prebuild stops emitting a release buildType', () => {
    expect(() => addInspectableReleaseOptIn('android {\n}\n')).toThrow('no release buildType block')
  })

  it('keeps the loopback security probe out of an inspectable release', () => {
    expect(probeSource).toContain('if (!BuildConfig.DEBUG || !isDebuggable) return null')
    expect(probeSource).not.toContain('isMobileWebInspectionEnabled(applicationFlags)) return')
  })
})
