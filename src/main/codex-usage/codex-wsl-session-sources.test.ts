import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  homes: vi.fn(),
  readdir: vi.fn(),
  realpath: vi.fn(),
  readfile: vi.fn(),
  lstat: vi.fn()
}))
vi.mock('../wsl/discovery/wsl-home-unless-stopped', () => ({
  readRunningWslHomeDirsUnlessStopped: mocks.homes
}))
vi.mock('../native-chat/wsl-transcript-fs-access', () => ({
  wslGatedReaddir: mocks.readdir,
  wslGatedRealpath: mocks.realpath,
  wslGatedReadFile: mocks.readfile,
  wslGatedLstat: mocks.lstat
}))
import { discoverWslCodexUsageSources } from './codex-wsl-session-sources'

const home = String.raw`\\wsl.localhost\Ubuntu-24.04\home\be0h`
const accounts = String.raw`\\wsl.localhost\Ubuntu-24.04\home\be0h\.local\share\orca\codex-accounts`

beforeEach(() => {
  vi.resetAllMocks()
  mocks.homes.mockResolvedValue({ homes: [home], confirmed: true })
  mocks.realpath.mockImplementation(async (path: string) => path)
  mocks.readdir.mockResolvedValue([{ name: 'account-1', isDirectory: () => true }])
  mocks.readfile.mockResolvedValue('account-1\n')
  mocks.lstat.mockResolvedValue({ isDirectory: () => true })
})

describe('WSL Codex usage source discovery', () => {
  it('includes system, legacy runtime and owned account sessions in the running distro', async () => {
    expect(await discoverWslCodexUsageSources('win32')).toEqual({
      sources: [
        {
          directory: String.raw`\\wsl.localhost\Ubuntu-24.04\home\be0h\.codex\sessions`,
          distro: 'Ubuntu-24.04'
        },
        {
          directory: String.raw`\\wsl.localhost\Ubuntu-24.04\home\be0h\.local\share\orca\codex-runtime-home\home\sessions`,
          distro: 'Ubuntu-24.04'
        },
        {
          directory: String.raw`\\wsl.localhost\Ubuntu-24.04\home\be0h\.local\share\orca\codex-accounts\account-1\home\sessions`,
          distro: 'Ubuntu-24.04'
        }
      ],
      wslHomes: [home],
      complete: true
    })
  })

  it.each([true, false])(
    'does not touch a stopped or unconfirmed distro (confirmed=%s)',
    async (confirmed) => {
      mocks.homes.mockResolvedValue({ homes: [], confirmed })
      mocks.realpath.mockRejectedValue(new Error('Stopped distro must not be touched'))
      expect(await discoverWslCodexUsageSources('win32')).toEqual({
        sources: [],
        wslHomes: [],
        complete: confirmed
      })
    }
  )

  it('does not follow redirected account homes and distinguishes unavailable roots from deletion', async () => {
    mocks.realpath.mockImplementation(async (path: string) =>
      path === accounts ? path : String.raw`\\wsl.localhost\Ubuntu-24.04\unrelated`
    )
    expect((await discoverWslCodexUsageSources('win32')).sources).toHaveLength(2)
    mocks.realpath.mockRejectedValue(Object.assign(new Error('Unavailable'), { code: 'EACCES' }))
    expect((await discoverWslCodexUsageSources('win32')).complete).toBe(false)
  })
})
