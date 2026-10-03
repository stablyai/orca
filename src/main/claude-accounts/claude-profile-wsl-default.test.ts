import { beforeEach, expect, it, vi } from 'vitest'
import { prepareClaudeWslDefaultGuest } from './claude-profile-wsl-default'
import { runWslProcess } from '../wsl/wsl-runner'
import { filterPathsToRunningWslDistrosAsync } from '../wsl-running-path-filter'

vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: vi.fn() }))
vi.mock('../wsl-running-path-filter', () => ({ filterPathsToRunningWslDistrosAsync: vi.fn() }))
vi.mock('./claude-profile-wsl-transport', () => ({}))
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(filterPathsToRunningWslDistrosAsync).mockImplementation(async (paths) => [...paths])
  vi.mocked(runWslProcess).mockResolvedValue({
    code: 0,
    timedOut: false,
    stdout: '/home/fake',
    stderr: '',
    environmentResolved: true
  })
})
it('publishes a System Default pointer without installing a runtime or reading credentials', async () => {
  for (const distro of ['Ubuntu', 'Debian']) {
    const guest = await prepareClaudeWslDefaultGuest(distro)
    expect(guest.home).toBe('/home/fake')
    await guest.request({
      action: 'publish',
      accountId: null,
      distro,
      userHome: guest.home,
      hooksEnabled: false
    })
  }
  expect(runWslProcess).toHaveBeenCalledTimes(4)
  const scripts = vi
    .mocked(runWslProcess)
    .mock.calls.map(([spec]) => spec.script)
    .join('\n')
  expect(scripts).toContain('mktemp')
  expect(scripts).toContain('mv -f')
  expect(scripts).not.toMatch(/\.credentials|keychain|curl|wget|node|claude auth/i)
  expect(vi.mocked(runWslProcess).mock.calls.every(([spec]) => spec.loginPath === 'none')).toBe(
    true
  )
})
it('does not boot a stopped distro in the background and visibly refuses a failed publication', async () => {
  vi.mocked(filterPathsToRunningWslDistrosAsync).mockResolvedValueOnce([])
  await expect(prepareClaudeWslDefaultGuest('Stopped')).rejects.toThrow('not running')
  expect(runWslProcess).not.toHaveBeenCalled()
  const guest = await prepareClaudeWslDefaultGuest('Stopped', 'boot')
  vi.mocked(runWslProcess).mockResolvedValueOnce({
    code: 1,
    timedOut: false,
    stdout: '',
    stderr: 'permission denied',
    environmentResolved: true
  })
  await expect(
    guest.request(
      {
        action: 'publish',
        accountId: null,
        distro: 'Stopped',
        userHome: guest.home,
        hooksEnabled: false
      },
      'boot'
    )
  ).rejects.toThrow()
  await expect(
    guest.request({
      action: 'publish',
      accountId: 'managed',
      distro: 'Stopped',
      userHome: guest.home,
      hooksEnabled: false
    })
  ).rejects.toThrow('pinned guest runtime')
})
