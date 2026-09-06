import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import disabledPageAsyncStorage, { useAsyncStorage } from './disabled-page-async-storage'

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
  it('aliases AsyncStorage only for the hosted web export and rejects page persistence', () => {
    expect(metroSource).toContain("process.env.ORCA_EXPO_ROUTER_ROOT === 'host-web-app'")
    expect(metroSource).toContain("moduleName === '@react-native-async-storage/async-storage'")
    expect(metroSource).toContain("platform !== 'web'")
    expect(verifierSource).toContain('mobileWebRnwExecutablePolicyFailure(source)')
    expect(executablePolicySource).toContain('RNW executable contains ${failure}')
  })

  it('returns inert values without touching browser storage', async () => {
    const callback = vi.fn()
    await expect(disabledPageAsyncStorage.getItem('secret', callback)).resolves.toBeNull()
    await expect(disabledPageAsyncStorage.setItem('secret', 'value')).resolves.toBeUndefined()
    await expect(disabledPageAsyncStorage.getAllKeys()).resolves.toEqual([])
    await expect(useAsyncStorage('secret').getItem()).resolves.toBeNull()
    expect(callback).toHaveBeenCalledWith(null, null)
  })
})
