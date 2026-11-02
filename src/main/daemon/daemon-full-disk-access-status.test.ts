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

it.each(['granted', 'denied', 'unknown'] as const)(
  'includes the older generation when it reports %s',
  async (status) => {
    legacy.getFullDiskAccessStatus.mockResolvedValue(status)
    expect(await getTerminalHostsFullDiskAccessStatus()).toBe(status)
    expect(current.getFullDiskAccessStatus).toHaveBeenCalledTimes(1)
    expect(legacy.getFullDiskAccessStatus).toHaveBeenCalledTimes(1)
  }
)

it('keeps an observed denial even if another generation cannot answer', async () => {
  current.getFullDiskAccessStatus.mockResolvedValue('unknown')
  legacy.getFullDiskAccessStatus.mockResolvedValue('denied')
  expect(await getTerminalHostsFullDiskAccessStatus()).toBe('denied')
})

it('does not launch a daemon merely to check permissions', async () => {
  state.installed = false
  expect(await getTerminalHostsFullDiskAccessStatus()).toBe('unknown')
  expect(current.getFullDiskAccessStatus).not.toHaveBeenCalled()
})

it('includes the in-process host used for fresh terminals in degraded mode', async () => {
  state.degraded = true
  expect(await getTerminalHostsFullDiskAccessStatus()).toBe('denied')
  expect(localStatus).toHaveBeenCalledTimes(1)
})
