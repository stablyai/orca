import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccumulator, finalizeSession } from './session-scanner-accumulator'
import type { OpenCodeSqliteProcessOptions } from './session-scanner-opencode-sqlite-process-client'

const mocks = vi.hoisted(() => ({
  running: vi.fn(async (paths: readonly string[]) => [...paths]),
  create: vi.fn((_options: OpenCodeSqliteProcessOptions) => ({ dispose: vi.fn() }))
}))
vi.mock('../wsl-running-path-filter', () => ({
  filterPathsToRunningWslDistrosAsync: mocks.running
}))
vi.mock('./session-scanner-opencode-sqlite-process-client', () => ({
  createOpenCodeSqliteProcessClient: mocks.create
}))
vi.mock('../wsl/wsl-executable-path', () => ({
  resolveWslExecutablePath: () => 'C:\\Windows\\System32\\wsl.exe'
}))
vi.mock('../wsl-interop-spawn-directory', () => ({
  resolveWslInteropSpawnCwd: () => 'C:\\Windows'
}))
import {
  configureOpenCodeWslReaders,
  mapOpenCodeWslSession,
  openCodeWslClient
} from './session-scanner-opencode-wsl-client'

const path = String.raw`\\wsl$\Ubuntu\home\ada\opencode.db`
const runtime = {
  distro: 'Ubuntu',
  executable: '/usr/bin/node',
  readerPath: '/mnt/c/reader $literal.cjs'
}

beforeEach(() => {
  configureOpenCodeWslReaders([])
  vi.clearAllMocks()
  mocks.running.mockImplementation(async (paths) => [...paths])
})
afterEach(() => {
  configureOpenCodeWslReaders([])
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('WSL SQLite reader clients', () => {
  it('reuses one client per distro and uses literal --exec argv with a safe host cwd and env', async () => {
    vi.stubEnv('NODE_OPTIONS', '--require=host-loader')
    vi.stubEnv('WSLENV', 'NODE_OPTIONS/u')
    configureOpenCodeWslReaders([runtime])
    const first = await openCodeWslClient('Ubuntu', path)
    configureOpenCodeWslReaders([
      { readerPath: runtime.readerPath, executable: runtime.executable, distro: 'ubuntu' }
    ])
    expect(await openCodeWslClient('ubuntu', path)).toBe(first)
    expect(mocks.create).toHaveBeenCalledOnce()
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['-d', 'Ubuntu', '--exec', '/usr/bin/node', '/mnt/c/reader $literal.cjs'],
        cwd: 'C:\\Windows'
      })
    )
    const options = mocks.create.mock.calls[0]?.[0]
    expect(options).toEqual(
      expect.objectContaining({
        env: expect.not.objectContaining({
          NODE_OPTIONS: expect.anything(),
          WSLENV: expect.anything()
        })
      })
    )
  })

  it('retires clients when a distro stops, configuration changes, or the distro disappears', async () => {
    configureOpenCodeWslReaders([runtime])
    await openCodeWslClient('Ubuntu', path)
    const first = mocks.create.mock.results[0]?.value
    mocks.running.mockResolvedValueOnce([])
    await expect(openCodeWslClient('Ubuntu', path)).rejects.toThrow('not running')
    expect(first?.dispose).toHaveBeenCalledOnce()
    await openCodeWslClient('Ubuntu', path)
    const second = mocks.create.mock.results[1]?.value
    configureOpenCodeWslReaders([{ ...runtime, executable: '/new/node' }])
    expect(second?.dispose).toHaveBeenCalledOnce()
    await openCodeWslClient('Ubuntu', path)
    const third = mocks.create.mock.results[2]?.value
    configureOpenCodeWslReaders([])
    expect(third?.dispose).toHaveBeenCalledOnce()
  })

  it('cancels a running-distro probe before creating a child', async () => {
    configureOpenCodeWslReaders([runtime])
    mocks.running.mockReturnValue(new Promise(() => {}))
    const controller = new AbortController()
    const pending = openCodeWslClient('Ubuntu', path, controller.signal)
    controller.abort(new Error('cancelled probe'))
    await expect(pending).rejects.toThrow('cancelled probe')
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('keeps unavailable readers unavailable until repaired configuration arrives', async () => {
    configureOpenCodeWslReaders([{ distro: 'Ubuntu', error: 'Preparing' }])
    await expect(openCodeWslClient('Ubuntu', path)).rejects.toThrow('Preparing')
    expect(mocks.create).not.toHaveBeenCalled()
    configureOpenCodeWslReaders([runtime])
    await openCodeWslClient('Ubuntu', path)
    expect(mocks.create).toHaveBeenCalledOnce()
  })

  it('restores the original database identity and distro cwd while retaining a Linux resume command', () => {
    const accumulator = createAccumulator({
      agent: 'opencode',
      sessionId: 'session',
      file: { path: '/home/ada/opencode.db', mtimeMs: 1, modifiedAt: new Date(1).toISOString() }
    })
    accumulator.cwd = '/home/ada/project $literal'
    accumulator.title = 'A session'
    const native = finalizeSession(accumulator, 'linux')
    const mapped = mapOpenCodeWslSession(native, path, 'Ubuntu')
    expect(mapped).toMatchObject({
      id: `local:opencode:session:${path}`,
      filePath: path,
      cwd: String.raw`\\wsl.localhost\Ubuntu\home\ada\project $literal`,
      executionHostPlatform: 'linux',
      resumeCommand: "cd '/home/ada/project $literal' && opencode --session 'session'"
    })
    expect(mapOpenCodeWslSession(null, path, 'Ubuntu')).toBeNull()
  })
})
