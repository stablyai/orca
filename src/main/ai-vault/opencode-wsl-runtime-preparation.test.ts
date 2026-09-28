import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RELAY_OPENCODE_SQLITE_READER_FILENAME } from '../../shared/relay-artifacts'
import { ORCAD_BUN_RELEASE_ASSETS } from '../../shared/orcad-bun-runtime'
import { runProcess } from '../../shared/child-process/run-process'
import type * as preparationModule from './opencode-wsl-runtime-preparation'

const mocks = vi.hoisted(() => ({
  exists: vi.fn((_path: string) => true),
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
const cachedRuntime = '/home/ada/.cache/orca/runtimes/verified/bun'
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
          : spec.program === 'uname'
            ? 'x86_64'
            : spec.script?.startsWith('getconf')
              ? 'glibc 2.31'
              : spec.script?.startsWith('printf')
                ? '/home/ada'
                : `__ORCA_BUN_READY__\n${cachedRuntime}\n`
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
  it('returns immediately, coalesces distro aliases, and selects verified Bun without probing host Node', async () => {
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
      { distro: 'ubuntu', executable: cachedRuntime, readerPath: '/mnt/c/reader.cjs' }
    ])
    expect(mocks.run.mock.calls.some(([spec]) => spec.program === 'node')).toBe(false)
    expect(mocks.bundles.mock.calls.map(([platform]) => platform)).toEqual([
      'linux-x64',
      'linux-arm64'
    ])
    expect(mocks.download).not.toHaveBeenCalled()
  })

  it.each([
    join('C:/app', 'session-scanner-opencode-sqlite-process-entry.js'),
    join('C:/relay/linux-x64', RELAY_OPENCODE_SQLITE_READER_FILENAME)
  ])('prepares the available headless or desktop reader: %s', async (reader) => {
    mocks.exists.mockImplementation((candidate) => candidate === reader)
    await prepared()
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'wslpath',
        args: ['-a', '-u', reader]
      })
    )
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
    expect((await prepared())[0]?.executable).toBe(cachedRuntime)
  })

  it('keeps a working reader during revalidation and prunes completed removed distros', async () => {
    let now = 10_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const ready = await prepared()
    const previousCalls = mocks.run.mock.calls.length
    now += 600_001
    let release: (value: ReturnType<typeof success>) => void = () => {}
    mocks.run.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      })
    )
    expect(await prepare([home])).toEqual(ready)
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(previousCalls + 1))
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

  it('installs the pinned proxy runtime, verifies the guest stage, and preserves literal argv', async () => {
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
      return success(
        spec.script?.includes('Uploaded Bun runtime checksum mismatch')
          ? `__ORCA_BUN_READY__\n/home/ada $literal/.cache/orca/runtimes/${expected}/bun\n`
          : '__ORCA_BUN_MISSING__\n'
      )
    })
    const result = await prepared()
    expect(mocks.download).toHaveBeenCalledWith(
      'linux-arm64-musl',
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(result[0]?.executable).toBe(`/home/ada $literal/.cache/orca/runtimes/${expected}/bun`)
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        script: expect.stringContaining('Uploaded Bun runtime checksum mismatch')
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
      return success('__ORCA_BUN_MISSING__\n')
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
    expect((await prepared())[0]?.executable).toBe(cachedRuntime)
    expect(mocks.running).toHaveBeenCalledWith(expect.any(Array), { requireConfirmed: true })
  })

  it.skipIf(process.platform === 'win32')(
    'keeps the discovery default visible when guest overrides point elsewhere',
    async () => {
      await prepared()
      const script = mocks.run.mock.calls[0]?.[0].script
      const directory = await mkdtemp(join(tmpdir(), 'orca-wsl-presence-'))
      try {
        const data = join(directory, '.local', 'share', 'opencode')
        await mkdir(data, { recursive: true })
        await writeFile(join(data, 'opencode.db'), '')
        const result = await runProcess({
          program: '/bin/sh',
          args: ['-c', script],
          env: {
            HOME: directory,
            XDG_DATA_HOME: join(directory, 'empty'),
            OPENCODE_DB: ':memory:'
          }
        })
        expect(result.code).toBe(0)
        expect(result.stdout).toBe('present')
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )
})
