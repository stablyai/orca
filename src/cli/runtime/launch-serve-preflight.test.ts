import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MacServeStartupAbortError } from './serve-signal-exit-diagnostic'

const { spawnMock, preflightMock, recordAbortMock, superviseMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  preflightMock: vi.fn(),
  recordAbortMock: vi.fn(),
  superviseMock: vi.fn()
}))

vi.mock('child_process', () => ({ spawn: spawnMock, spawnSync: vi.fn() }))
vi.mock('./serve-electron-preflight', () => ({
  preflightElectronServe: preflightMock,
  recordElectronServeStartupAbort: recordAbortMock
}))
vi.mock('./serve-update-supervisor', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  superviseForegroundServe: superviseMock
}))

import { serveOrcaApp } from './launch'

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  kill = vi.fn()
  unref = vi.fn()
  pid = 4101
}

const PROFILE = resolve('/profiles/serve-preflight')

describe('serveOrcaApp: Electron serve preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    spawnMock.mockReturnValue(new FakeChildProcess())
    process.env.ORCA_APP_EXECUTABLE = '/opt/orca/orca'
    process.env.ORCA_SERVE_RUNTIME = 'electron'
    process.env.ORCA_USER_DATA_PATH = PROFILE
  })

  afterEach(() => {
    delete process.env.ORCA_APP_EXECUTABLE
    delete process.env.ORCA_SERVE_RUNTIME
    delete process.env.ORCA_USER_DATA_PATH
  })

  it('never execs a second Electron main once the preflight refuses', async () => {
    preflightMock.mockReturnValue(Promise.resolve(3))

    await expect(serveOrcaApp({ json: true })).resolves.toBe(3)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(preflightMock).toHaveBeenCalledWith({ json: true }, PROFILE)
  })

  it('execs once the preflight finds the profile free', async () => {
    preflightMock.mockReturnValue(Promise.resolve(null))
    superviseMock.mockResolvedValue(0)

    await expect(serveOrcaApp({})).resolves.toBe(0)
    expect(spawnMock).toHaveBeenCalledOnce()
  })

  it('remembers a prompt macOS startup abort for the next separate run', async () => {
    preflightMock.mockReturnValue(null)
    const abort = new MacServeStartupAbortError('runtime_serve_failed', 'aborted at startup')
    superviseMock.mockRejectedValue(abort)

    await expect(serveOrcaApp({})).rejects.toBe(abort)
    expect(recordAbortMock).toHaveBeenCalledWith(PROFILE, 'aborted at startup')
  })
})
