import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

// Why: Home's cold start imports this chain statically (app/index.tsx -> MobileHomeScreen ->
// host-removal-lifecycle -> mobile-web-native-stager), so a module-scope throw white-screens the
// launch on any build without the pod (Expo Go, a stale dev client) instead of degrading.
vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => null,
  requireNativeModule: () => {
    throw new Error('Cannot find native module')
  }
}))

describe('expo mobile web shell without the native module', () => {
  it('loads without throwing and rejects at the call instead', async () => {
    const module = await import('../../packages/expo-mobile-web-shell/src/ExpoMobileWebShellModule')

    await expect(module.default.removeHost('host-key')).rejects.toThrow(
      'ExpoMobileWebShell is unavailable'
    )
  })

  it('never resolves the module with the throwing variant at import time', () => {
    const source = readFileSync(
      new URL(
        '../../packages/expo-mobile-web-shell/src/ExpoMobileWebShellModule.ts',
        import.meta.url
      ),
      'utf8'
    )

    expect(source).not.toContain('requireNativeModule<')
    expect(source).toContain('requireOptionalNativeModule<')
  })
})
