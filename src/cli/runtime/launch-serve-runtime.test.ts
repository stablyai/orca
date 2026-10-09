import { EventEmitter } from 'node:events'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, resolveLocalServeRuntimeMock, serveWithOrcadMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  resolveLocalServeRuntimeMock: vi.fn(),
  serveWithOrcadMock: vi.fn()
}))

vi.mock('child_process', () => ({ spawn: spawnMock, spawnSync: vi.fn() }))
vi.mock('./serve-orcad-launch', () => ({
  resolveLocalServeRuntime: resolveLocalServeRuntimeMock,
  serveWithOrcad: serveWithOrcadMock
}))

import { serveOrcaApp } from './launch'

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  kill = vi.fn()
  unref = vi.fn()
  pid = 4101
}

/** Electron serve that exits cleanly once spawned, whenever selection gets to spawning it. */
function electronChild(): void {
  spawnMock.mockImplementation(() => {
    const child = new FakeChildProcess()
    setTimeout(() => child.emit('exit', 0, null), 0)
    return child
  })
}

describe('orca serve host selection', () => {
  let stderr: string[]

  beforeEach(() => {
    spawnMock.mockReset()
    resolveLocalServeRuntimeMock.mockReset()
    serveWithOrcadMock.mockReset()
    process.env.ORCA_APP_EXECUTABLE = '/opt/orca/orca-ide'
    stderr = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk))
      return true
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.ORCA_APP_EXECUTABLE
    delete process.env.ORCA_SERVE_RUNTIME
    delete process.env.ORCA_USER_DATA_PATH
    delete process.env.ORCA_DEV_USER_DATA_PATH
    delete process.env.ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT
  })

  it('serves on orcad by default', async () => {
    const selection = { kind: 'orcad', runtime: '/node', entry: '/slot/orcad.js', version: '1' }
    resolveLocalServeRuntimeMock.mockResolvedValue(selection)
    serveWithOrcadMock.mockResolvedValue(0)

    await expect(serveOrcaApp({ json: true })).resolves.toBe(0)
    expect(serveWithOrcadMock).toHaveBeenCalledWith(
      selection,
      { json: true },
      expect.any(String),
      expect.not.objectContaining({ ELECTRON_RUN_AS_NODE: expect.anything() })
    )
    expect(spawnMock).not.toHaveBeenCalled()
    expect(stderr.join('')).toContain('[serve] running on orcad 1')
  })

  it('falls back to Electron and prints why when orcad cannot serve', async () => {
    resolveLocalServeRuntimeMock.mockResolvedValue({ kind: 'electron', reason: 'no template' })
    electronChild()

    await expect(serveOrcaApp({ json: true })).resolves.toBe(0)
    expect(spawnMock).toHaveBeenCalledWith(
      '/opt/orca/orca-ide',
      expect.arrayContaining(['--serve', '--serve-json']),
      expect.any(Object)
    )
    expect(stderr.join('')).toContain('[serve] using Electron serve: no template')
  })

  it('keeps Electron without asking orcad when ORCA_SERVE_RUNTIME=electron', async () => {
    process.env.ORCA_SERVE_RUNTIME = 'electron'
    electronChild()

    await expect(serveOrcaApp({ json: true })).resolves.toBe(0)
    expect(resolveLocalServeRuntimeMock).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalledOnce()
    expect(stderr.join('')).not.toContain('[serve]')
  })

  describe('serves the profile it selected on', () => {
    function electronSpawn(): { args: string[]; env: NodeJS.ProcessEnv } {
      const [, args, options] = spawnMock.mock.calls[0]
      return { args, env: options.env }
    }

    it('starts the Electron fallback on ORCA_USER_DATA_PATH, not the default profile', async () => {
      const profile = resolve('/isolated/profile-r')
      process.env.ORCA_USER_DATA_PATH = profile
      resolveLocalServeRuntimeMock.mockResolvedValue({ kind: 'electron', reason: 'ssh targets' })
      electronChild()

      await expect(serveOrcaApp({ json: true })).resolves.toBe(0)
      expect(resolveLocalServeRuntimeMock).toHaveBeenCalledWith(
        expect.objectContaining({ userDataPath: profile })
      )
      const child = electronSpawn()
      expect(child.args).toContain(`--user-data-dir=${profile}`)
      expect(child.env).toMatchObject({
        ORCA_USER_DATA_PATH: profile,
        ORCA_SERVE_USER_DATA_PATH: profile
      })
    })

    it('pins the opt-out Electron serve to the same profile', async () => {
      const profile = resolve('/isolated/profile-e')
      process.env.ORCA_USER_DATA_PATH = profile
      process.env.ORCA_SERVE_RUNTIME = 'electron'
      electronChild()

      await expect(serveOrcaApp({ json: true })).resolves.toBe(0)
      expect(electronSpawn().args).toContain(`--user-data-dir=${profile}`)
    })

    it('hands orcad the absolute profile the selector read', async () => {
      process.env.ORCA_USER_DATA_PATH = join('relative', 'profile')
      const selection = { kind: 'orcad', runtime: '/node', entry: '/slot/orcad.js', version: '1' }
      resolveLocalServeRuntimeMock.mockResolvedValue(selection)
      serveWithOrcadMock.mockResolvedValue(0)

      await expect(serveOrcaApp({})).resolves.toBe(0)
      const profile = resolve('relative', 'profile')
      expect(resolveLocalServeRuntimeMock).toHaveBeenCalledWith(
        expect.objectContaining({ userDataPath: profile })
      )
      expect(serveWithOrcadMock).toHaveBeenCalledWith(selection, {}, profile, expect.any(Object))
    })

    it('uses ORCA_DEV_USER_DATA_PATH for both the selector and a dev Electron child', async () => {
      const profile = resolve('/isolated/dev-profile')
      delete process.env.ORCA_USER_DATA_PATH
      process.env.ORCA_DEV_USER_DATA_PATH = profile
      process.env.ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT = '1'
      resolveLocalServeRuntimeMock.mockResolvedValue({ kind: 'electron', reason: 'dev' })
      electronChild()

      await expect(serveOrcaApp({ json: true })).resolves.toBe(0)
      expect(resolveLocalServeRuntimeMock).toHaveBeenCalledWith(
        expect.objectContaining({ userDataPath: profile })
      )
      // A dev build ignores --user-data-dir and reads this instead.
      expect(electronSpawn().env).toMatchObject({
        ORCA_DEV_USER_DATA_PATH: profile,
        ORCA_SERVE_USER_DATA_PATH: profile
      })
    })
  })
})
