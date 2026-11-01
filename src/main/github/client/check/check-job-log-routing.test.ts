import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BackgroundDistroGate from '../../../wsl-background-distro-gate'
import {
  fakeSpawnDispatch,
  createFakeSpawnedChild
} from '../../../../shared/__fixtures__/fake-spawned-child'
import type * as WslModule from '../../../wsl'
import { attachLogFixture, failedLogJob } from './check-job-log-test-fixture'
import { startCheckJobLogDownload } from './check-job-log-download'
import { prCheckLogTailCache } from './check-job-log-tails'
import { setDefaultWslDistroOverride } from '../../../git/runner'
const { spawnMock, distroMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), distroMock: vi.fn() }))
// The default-distro fallback asks whether the distro runs before it may start it (E9).
vi.mock('../../../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof BackgroundDistroGate>()),
  readWslDistroRunningState: vi.fn(async () => 'running')
}))

vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: spawnMock }))
vi.mock('../../../wsl', async (original) => ({
  ...(await original<typeof WslModule>()),
  getDefaultWslDistro: distroMock
}))
const nativePlatform = process.platform
const repo = { owner: 'acme', repo: 'widgets' }
describe('stateless flag attempts retain actual runner routing', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    distroMock.mockReset().mockReturnValue('Ubuntu')
    setDefaultWslDistroOverride(null)
    prCheckLogTailCache.clear()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: nativePlatform })
    setDefaultWslDistroOverride(null)
    vi.restoreAllMocks()
  })
  it('WSL missing to native parser fallback keeps both calls flagged before the one unflagged attempt', async () => {
    spawnMock.mockImplementation(
      fakeSpawnDispatch((program, argv) =>
        program.endsWith('wsl.exe')
          ? { code: 127, stderr: 'bash: gh: command not found' }
          : argv.includes('--allow-escape-sequences')
            ? { code: 1, stderr: 'unknown flag: --allow-escape-sequences\n' }
            : { stdout: 'native log' }
      )
    )
    const controller = new AbortController()
    const call = startCheckJobLogDownload(
      repo,
      77,
      {
        host: 'github.com',
        wslDistro: 'Ubuntu',
        env: { GH_TOKEN: 'snapshot' },
        signal: controller.signal
      },
      Date.now() + 25_000,
      vi.fn()
    )
    await expect(call.result).resolves.toBe('native log')
    await call.terminated
    expect(spawnMock.mock.calls.map((call) => call[0])).toEqual(['wsl.exe', 'gh', 'wsl.exe', 'gh'])
    expect(spawnMock.mock.calls[0][1].at(-1)).toContain('--allow-escape-sequences')
    expect(spawnMock.mock.calls[1][1]).toContain('--allow-escape-sequences')
    expect(spawnMock.mock.calls[2][1].at(-1)).not.toContain('--allow-escape-sequences')
    expect(spawnMock.mock.calls[3][1]).not.toContain('--allow-escape-sequences')
    expect(spawnMock.mock.calls[3][2].env.GH_TOKEN).toBe('snapshot')
  })
  it('native missing to default WSL parser fallback keeps one logical fallback and every routed capture', async () => {
    const guest = fakeSpawnDispatch((_program, argv) =>
      argv.at(-1)?.includes('--allow-escape-sequences')
        ? { code: 1, stderr: 'unknown flag: --allow-escape-sequences\n' }
        : { stdout: 'guest log' }
    )
    spawnMock.mockImplementation((program: string, argv: string[]) => {
      if (program !== 'gh') {
        return guest(program, argv)
      }
      const child = createFakeSpawnedChild()
      Object.defineProperty(child, 'pid', { value: undefined })
      queueMicrotask(() =>
        child.emit('error', Object.assign(new Error('gh absent'), { code: 'ENOENT' }))
      )
      return child
    })
    const call = startCheckJobLogDownload(
      repo,
      77,
      { host: 'github.com', env: {}, signal: new AbortController().signal },
      Date.now() + 25_000,
      vi.fn()
    )
    await expect(call.result).resolves.toBe('guest log')
    await call.terminated
    expect(spawnMock.mock.calls.map((call) => call[0])).toEqual(['gh', 'wsl.exe', 'gh', 'wsl.exe'])
    expect(spawnMock.mock.calls[0][1]).toContain('--allow-escape-sequences')
    expect(spawnMock.mock.calls[1][1].at(-1)).toContain('--allow-escape-sequences')
    expect(spawnMock.mock.calls[2][1]).not.toContain('--allow-escape-sequences')
    expect(spawnMock.mock.calls[3][1].at(-1)).not.toContain('--allow-escape-sequences')
    expect(
      spawnMock.mock.calls.every((call) =>
        call[1].some((arg: string) => arg.includes('repos/acme/widgets/actions/jobs/77/logs'))
      )
    ).toBe(true)
  })
  it('cwd-less Windows routes bypass cache and sharing (1/1/2)', async () => {
    spawnMock.mockImplementation(fakeSpawnDispatch(() => ({ stdout: 'native log' })))
    const options = { env: { GH_TOKEN: 'native-token' } }
    await attachLogFixture([failedLogJob()], { options })
    await attachLogFixture([failedLogJob()], { options })
    expect(spawnMock).toHaveBeenCalledTimes(2)
    await Promise.all([
      attachLogFixture([failedLogJob()], { options }),
      attachLogFixture([failedLogJob()], { options })
    ])
    expect(spawnMock).toHaveBeenCalledTimes(4)
    expect(prCheckLogTailCache.size).toBe(0)
  })
})
