import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCAD_BUN_RELEASE_ASSETS } from '../../shared/orcad-bun-runtime'
import type * as preparationModule from './opencode-wsl-runtime-preparation'

const mocks = vi.hoisted(() => ({
  exists: vi.fn(() => true),
  run: vi.fn(),
  running: vi.fn(async (paths: readonly string[]) => [...paths]),
  download: vi.fn(async () => 'C:\\cache\\bun'),
  bundles: vi.fn((platform: string) => [`C:/relay/${platform}`])
}))
vi.mock('node:fs', () => ({ existsSync: mocks.exists }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({
    getAppPath: () => 'C:/app',
    getPath: () => 'C:/profile'
  })
}))
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: mocks.run }))
vi.mock('../wsl-running-path-filter', () => ({
  filterPathsToRunningWslDistrosAsync: mocks.running
}))
vi.mock('../ssh/orcad-bun-runtime-materializer', () => ({
  materializeCachedOrcadBunRuntime: mocks.download
}))
vi.mock('../ssh/relay-bundle-paths', () => ({ relayBundleCandidates: mocks.bundles }))

const home = String.raw`\\wsl.localhost\Ubuntu\home\ada`
const success = (stdout: string) => ({ stdout, stderr: '', code: 0, timedOut: false })
let prepare: typeof preparationModule.prepareOpenCodeWslReaders

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  mocks.exists.mockReturnValue(true)
  mocks.running.mockImplementation(async (paths) => [...paths])
  mocks.run.mockImplementation(async (spec) =>
    success(
      spec.script?.startsWith('data=')
        ? 'present'
        : spec.program === 'wslpath'
          ? '/mnt/c/reader.cjs'
          : '/usr/bin/node'
    )
  )
  prepare = (await import('./opencode-wsl-runtime-preparation')).prepareOpenCodeWslReaders
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function prepared() {
  let result = await prepare([home])
  await vi.waitFor(async () => {
    result = await prepare([home])
    expect(result[0]?.executable).toBeDefined()
  })
  return result
}

describe('WSL SQLite runtime preparation', () => {
  it('returns immediately, coalesces distro aliases, and uses an actual guest SQLite probe', async () => {
    let release: (value: ReturnType<typeof success>) => void = () => {}
    mocks.run.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      })
    )
    expect(await prepare([home, String.raw`\\wsl$\ubuntu\home\ada`])).toHaveLength(1)
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce())
    expect((await prepare([home]))[0]?.error).toContain('Preparing')
    expect(mocks.run).toHaveBeenCalledOnce()
    release(success('present'))
    expect(await prepared()).toEqual([
      { distro: 'ubuntu', executable: '/usr/bin/node', readerPath: '/mnt/c/reader.cjs' }
    ])
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'node',
        loginPath: 'preferred',
        args: ['-e', expect.stringContaining("require('node:sqlite')")]
      })
    )
    expect(mocks.bundles.mock.calls.map(([platform]) => platform)).toEqual([
      'linux-x64',
      'linux-arm64'
    ])
    expect(mocks.download).not.toHaveBeenCalled()
  })

  it('does not start a stopped distro and retries a failed preparation after cooldown', async () => {
    let now = 10_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    mocks.running.mockResolvedValue([])
    await prepare([home])
    await vi.waitFor(async () => expect((await prepare([home]))[0]?.error).toContain('not running'))
    expect(mocks.run).not.toHaveBeenCalled()
    mocks.running.mockImplementation(async (paths) => [...paths])
    expect((await prepare([home]))[0]?.error).toContain('not running')
    now += 30_001
    expect((await prepared())[0]?.executable).toBe('/usr/bin/node')
  })

  it('keeps a working reader during revalidation and prunes completed removed distros', async () => {
    let now = 10_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const ready = await prepared()
    now += 600_001
    let release: (value: ReturnType<typeof success>) => void = () => {}
    mocks.run.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      })
    )
    expect(await prepare([home])).toEqual(ready)
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(4))
    expect(await prepare([home])).toEqual(ready)
    mocks.run.mockResolvedValueOnce(success('/mnt/c/repaired-reader.cjs'))
    release(success('present'))
    await vi.waitFor(async () =>
      expect((await prepare([home]))[0]?.readerPath).toBe('/mnt/c/repaired-reader.cjs')
    )
    expect(await prepare([])).toEqual([])
    expect((await prepare([home]))[0]?.error).toContain('Preparing')
    await prepared()
  })

  it('falls back to the pinned proxy runtime, verifies the guest stage, and preserves literal argv', async () => {
    const expected = ORCAD_BUN_RELEASE_ASSETS['linux-arm64-musl'].executableSha256
    mocks.run.mockImplementation(async (spec) => {
      if (spec.script?.startsWith('data=')) {
        return success('present')
      }
      if (spec.program === 'node') {
        return { ...success(''), code: 1, stderr: 'no sqlite' }
      }
      if (spec.program === 'uname') {
        return success('aarch64')
      }
      if (spec.program === 'wslpath') {
        return success('/mnt/c/reader $literal.cjs')
      }
      if (spec.script?.startsWith('getconf')) {
        return success('musl libc')
      }
      if (spec.script?.startsWith('printf')) {
        return success('/home/ada $literal')
      }
      return success('')
    })
    const result = await prepared()
    expect(mocks.download).toHaveBeenCalledWith(
      'linux-arm64-musl',
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(result[0]?.executable).toBe(
      `/home/ada $literal/.cache/orca/vault-sqlite/${expected}/bun`
    )
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['/mnt/c/reader $literal.cjs', result[0]?.executable, expected],
        script: expect.stringContaining('actual=$(sha256sum -- "$stage")')
      })
    )
    expect(
      mocks.run.mock.calls.every(
        ([spec]) => spec.timeoutMs <= 15_000 && spec.maxOutputBytes === 16_384
      )
    ).toBe(true)
  })

  it('rechecks running state after downloading before it copies a runtime', async () => {
    mocks.run.mockImplementation(async (spec) => {
      if (spec.script?.startsWith('data=')) {
        return success('present')
      }
      if (spec.program === 'node') {
        return { ...success(''), code: 1 }
      }
      if (spec.program === 'uname') {
        return success('x86_64')
      }
      if (spec.program === 'wslpath') {
        return success('/mnt/c/reader.cjs')
      }
      if (spec.script?.startsWith('getconf')) {
        return success('glibc 2.31')
      }
      if (spec.script?.startsWith('printf')) {
        return success('/home/ada')
      }
      return success('')
    })
    mocks.download.mockImplementationOnce(async () => {
      mocks.running.mockResolvedValue([])
      return 'C:\\cache\\bun'
    })
    await prepare([home])
    await vi.waitFor(async () => expect((await prepare([home]))[0]?.error).toContain('not running'))
    expect(mocks.run.mock.calls.some(([spec]) => spec.script?.includes('mv -f'))).toBe(false)
  })

  it('ignores native roots and does no work outside Windows', async () => {
    expect(await prepare(['C:\\Users\\ada'])).toEqual([])
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    expect(await prepare([home])).toEqual([])
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('skips runtime setup without a database and rechecks soon after OpenCode starts', async () => {
    let now = 10_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    mocks.run.mockResolvedValueOnce(success(''))
    await prepare([home])
    await vi.waitFor(async () =>
      expect((await prepare([home]))[0]?.error).toContain('No OpenCode database')
    )
    expect(mocks.run).toHaveBeenCalledOnce()
    expect(mocks.download).not.toHaveBeenCalled()
    expect(mocks.run.mock.calls[0]?.[0].script).toContain('OPENCODE_DB')
    expect(mocks.run.mock.calls[0]?.[0].script).toContain('XDG_DATA_HOME')
    now += 30_001
    expect((await prepared())[0]?.executable).toBe('/usr/bin/node')
    expect(mocks.running).toHaveBeenCalledWith(expect.any(Array), { requireConfirmed: true })
  })
})
