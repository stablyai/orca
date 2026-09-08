import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const metroSource = readFileSync(new URL('../../metro.config.js', import.meta.url), 'utf8')
const verifierSource = readFileSync(
  new URL('../../../config/scripts/verify-mobile-web-rnw-build.mjs', import.meta.url),
  'utf8'
)
const executablePolicySource = readFileSync(
  new URL('../../../config/scripts/mobile-web-rnw-executable-policy.mjs', import.meta.url),
  'utf8'
)

describe('hosted mobile web page storage', () => {
  it('aliases AsyncStorage only for the hosted web export and keeps browser storage inaccessible', () => {
    expect(metroSource).toContain("process.env.ORCA_EXPO_ROUTER_ROOT === 'host-web-app'")
    expect(metroSource).toContain("moduleName === '@react-native-async-storage/async-storage'")
    expect(metroSource).toContain("platform !== 'web'")
    expect(metroSource).toContain('hosted-page-async-storage.ts')
    expect(verifierSource).toContain('mobileWebRnwExecutablePolicyFailure(source)')
    expect(executablePolicySource).toContain('RNW executable contains ${failure}')
  })
})
