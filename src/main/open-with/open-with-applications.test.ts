import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OPEN_WITH_CHOOSER_APPLICATION_ID } from '../../shared/shell-open-types'
import { launchOpenWithApplication, sortOpenWithApplications } from './open-with-applications'

const APPS = [
  { id: 'windows:c:\\code.exe', name: 'Visual Studio Code' },
  { id: 'windows:c:\\notepad++.exe', name: 'Notepad++' },
  { id: 'windows:c:\\powerpnt.exe', name: 'Microsoft PowerPoint', isDefault: true },
  { id: 'windows:c:\\cursor.exe', name: 'Cursor' }
]

describe('sortOpenWithApplications', () => {
  it('puts the default first, then sorts by name, when nothing is recent', () => {
    expect(sortOpenWithApplications(APPS, []).map((a) => a.name)).toEqual([
      'Microsoft PowerPoint',
      'Cursor',
      'Notepad++',
      'Visual Studio Code'
    ])
  })

  it('ranks recently used applications ahead of the default', () => {
    const sorted = sortOpenWithApplications(APPS, [
      'windows:c:\\notepad++.exe',
      'windows:c:\\code.exe'
    ])
    expect(sorted.map((a) => a.name)).toEqual([
      'Notepad++',
      'Visual Studio Code',
      'Microsoft PowerPoint',
      'Cursor'
    ])
  })

  it('ignores recent ids that are no longer discovered', () => {
    const sorted = sortOpenWithApplications(APPS, ['windows:c:\\uninstalled.exe'])
    expect(sorted[0].name).toBe('Microsoft PowerPoint')
  })

  it('does not mutate the input array', () => {
    const input = [...APPS]
    sortOpenWithApplications(input, ['windows:c:\\cursor.exe'])
    expect(input).toEqual(APPS)
  })
})

describe('launchOpenWithApplication', () => {
  // Why: the renderer only echoes ids; anything discovery never produced must
  // resolve to no launch spec and spawn nothing.
  it('refuses ids that were never produced by discovery', async () => {
    await expect(launchOpenWithApplication('linux:forged.desktop', '/tmp/x')).resolves.toBe(false)
  })

  it('refuses the chooser id on non-Windows platforms', async () => {
    await expect(
      launchOpenWithApplication(OPEN_WITH_CHOOSER_APPLICATION_ID, '/tmp/x', { platform: 'linux' })
    ).resolves.toBe(false)
  })
})

vi.mock('./linux-open-with-applications', () => ({
  listLinuxOpenWithApplications: vi.fn(async () => []),
  buildLinuxLaunchInvocation: vi.fn(() => null)
}))

describe('listOpenWithApplications caching', () => {
  const CANDIDATE = {
    id: 'linux:editor.desktop',
    name: 'Editor',
    isDefault: true,
    launch: { kind: 'linux-desktop-entry' as const, execTokens: ['editor', '%f'] }
  }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function loadModules() {
    const linux = await import('./linux-open-with-applications')
    const applications = await import('./open-with-applications')
    return { discover: vi.mocked(linux.listLinuxOpenWithApplications), applications }
  }

  it('deduplicates concurrent listings for the same extension', async () => {
    const { discover, applications } = await loadModules()
    let settle: (candidates: (typeof CANDIDATE)[]) => void = () => {}
    discover.mockImplementation(() => new Promise((resolve) => (settle = resolve)))

    const first = applications.listOpenWithApplications('/tmp/a.md', { platform: 'linux' })
    const second = applications.listOpenWithApplications('/tmp/b.md', { platform: 'linux' })
    settle([CANDIDATE])

    expect((await first).applications).toEqual([
      { id: CANDIDATE.id, name: 'Editor', isDefault: true }
    ])
    expect((await second).applications).toHaveLength(1)
    expect(discover).toHaveBeenCalledTimes(1)
  })

  it('serves the cache inside the TTL and rediscovers after it expires', async () => {
    vi.useFakeTimers()
    const { discover, applications } = await loadModules()
    discover.mockResolvedValue([CANDIDATE])

    await applications.listOpenWithApplications('/tmp/a.md', { platform: 'linux' })
    await applications.listOpenWithApplications('/tmp/b.md', { platform: 'linux' })
    expect(discover).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5 * 60_000 + 1)
    await applications.listOpenWithApplications('/tmp/c.md', { platform: 'linux' })
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed discovery', async () => {
    const { discover, applications } = await loadModules()
    discover.mockRejectedValueOnce(new Error('xdg-mime missing'))

    expect(
      (await applications.listOpenWithApplications('/tmp/a.md', { platform: 'linux' })).applications
    ).toEqual([])

    discover.mockResolvedValue([CANDIDATE])
    expect(
      (await applications.listOpenWithApplications('/tmp/b.md', { platform: 'linux' })).applications
    ).toHaveLength(1)
    expect(discover).toHaveBeenCalledTimes(2)
  })
})
