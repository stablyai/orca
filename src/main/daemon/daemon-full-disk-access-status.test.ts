import { beforeEach, expect, it, vi } from 'vitest'
import type { DeveloperPermissionStatus } from '../../shared/developer-permissions-types'

const { state, current, legacy, DegradedProvider, localStatus } = vi.hoisted(() => ({
  state: { installed: true, degraded: false },
  DegradedProvider: class {},
  localStatus: vi.fn<() => Promise<DeveloperPermissionStatus>>(),
  current: { getFullDiskAccessStatus: vi.fn<() => Promise<DeveloperPermissionStatus>>() },
  legacy: { getFullDiskAccessStatus: vi.fn<() => Promise<DeveloperPermissionStatus>>() }
}))
vi.mock('./daemon-provider-state', () => ({
  getDaemonProvider: () => (state.installed ? (state.degraded ? new DegradedProvider() : {}) : null)
}))
vi.mock('./degraded-daemon-pty-provider', () => ({ DegradedDaemonPtyProvider: DegradedProvider }))
vi.mock('../macos-full-disk-access-status', () => ({ getMacosFullDiskAccessStatus: localStatus }))
vi.mock('./daemon-provider-routing', () => ({
  getCurrentDaemonAdapter: () => current,
  getLegacyDaemonAdapters: () => [legacy]
}))
import { getTerminalHostsFullDiskAccessStatus } from './daemon-full-disk-access-status'

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  state.installed = true
  state.degraded = false
  localStatus.mockReset().mockResolvedValue('denied')
  current.getFullDiskAccessStatus.mockReset().mockResolvedValue('granted')
  legacy.getFullDiskAccessStatus.mockReset().mockResolvedValue('granted')
})

it('keeps an observed denial even if another generation cannot answer', async () => {
  current.getFullDiskAccessStatus.mockResolvedValue('unknown')
  legacy.getFullDiskAccessStatus.mockResolvedValue('denied')
  expect(await getTerminalHostsFullDiskAccessStatus()).toBe('denied')
})
