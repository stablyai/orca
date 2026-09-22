import { beforeEach, expect, it, vi } from 'vitest'

const requireNativeModule = vi.hoisted(() => vi.fn())
vi.mock('expo-modules-core', () => ({ requireNativeModule }))

beforeEach(() => {
  vi.resetModules()
  requireNativeModule.mockReset()
})

it('requires the iOS ledger and surfaces a missing native module as a build defect', async () => {
  requireNativeModule.mockImplementation(() => {
    throw new Error('Cannot find native module OrcaNotificationDismissal')
  })
  await expect(import('./native-push-dismissal.ios')).rejects.toThrow(
    'Cannot find native module OrcaNotificationDismissal'
  )
})

it('does not load an iOS module on the default Android/web path', async () => {
  expect((await import('./native-push-dismissal')).nativePushDismissal).toBeNull()
  expect(requireNativeModule).not.toHaveBeenCalled()
})
