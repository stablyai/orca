import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

import { launchOrcaApp, serveOrcaApp } from './launch'

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  kill = vi.fn()
  unref = vi.fn()
}

describe('serveOrcaApp', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    process.env.ORCA_APP_EXECUTABLE = '/Applications/Orca.app/Contents/MacOS/Orca'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.ORCA_APP_EXECUTABLE
    delete process.env.ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT
    delete globalThis.__ORCA_NODE_SERVER_SERVE__
  })

  it('delegates serve to the node-server hook when bundled for the npm server package', async () => {
    const serveHook = vi.fn().mockResolvedValue(0)
    globalThis.__ORCA_NODE_SERVER_SERVE__ = serveHook

    await expect(
      serveOrcaApp({
        json: true,
        port: '6768',
        pairingAddress: '100.64.1.20',
        userDataPath: '/srv/orca-data',
        noPairing: true
      })
    ).resolves.toBe(0)

    expect(serveHook).toHaveBeenCalledWith({
      json: true,
      port: '6768',
      pairingAddress: '100.64.1.20',
      userDataPath: '/srv/orca-data',
      noPairing: true
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects --user-data on the Electron foreground serve path', async () => {
    expect(() => serveOrcaApp({ userDataPath: '/srv/orca-data' })).toThrow(
      '`orca serve --user-data` is only supported by @stablyai/orca-server.'
    )
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('pins the Electron child cwd to the app root instead of the caller cwd', async () => {
    const child = {
      kill: vi.fn(),
      once: vi.fn(
        (event: string, handler: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            queueMicrotask(() => handler(0, null))
          }
          return child
        }
      )
    }
    spawnMock.mockReturnValue(child)

    await expect(serveOrcaApp({ json: true })).resolves.toBe(0)

    expect(spawnMock).toHaveBeenCalledWith(
      '/Applications/Orca.app/Contents/MacOS/Orca',
      ['--serve', '--serve-json'],
      expect.objectContaining({
        cwd: resolve(__dirname, '../../..')
      })
    )
  })

  it('passes mobile pairing through to the foreground server child', async () => {
    const child = {
      kill: vi.fn(),
      once: vi.fn(
        (event: string, handler: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            queueMicrotask(() => handler(0, null))
          }
          return child
        }
      )
    }
    spawnMock.mockReturnValue(child)

    await expect(
      serveOrcaApp({
        json: true,
        port: '6768',
        pairingAddress: '100.64.1.20',
        mobilePairing: true
      })
    ).resolves.toBe(0)

    expect(spawnMock).toHaveBeenCalledWith(
      '/Applications/Orca.app/Contents/MacOS/Orca',
      [
        '--serve',
        '--serve-json',
        '--serve-port',
        '6768',
        '--serve-pairing-address',
        '100.64.1.20',
        '--serve-mobile-pairing'
      ],
      expect.objectContaining({
        cwd: resolve(__dirname, '../../..')
      })
    )
  })

  it('passes the app root before serve flags for dev Electron executables', async () => {
    process.env.ORCA_APP_EXECUTABLE = '/repo/node_modules/.bin/electron'
    process.env.ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT = '1'
    const child = {
      kill: vi.fn(),
      once: vi.fn(
        (event: string, handler: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            queueMicrotask(() => handler(0, null))
          }
          return child
        }
      )
    }
    spawnMock.mockReturnValue(child)

    await expect(serveOrcaApp({ json: true, port: '6768' })).resolves.toBe(0)

    expect(spawnMock).toHaveBeenCalledWith(
      '/repo/node_modules/.bin/electron',
      [resolve(__dirname, '../../..'), '--serve', '--serve-json', '--serve-port', '6768'],
      expect.objectContaining({
        cwd: resolve(__dirname, '../../..')
      })
    )
  })

  it('prints recipe JSON from a detached server child and exits', async () => {
    const child = new FakeChildProcess()
    spawnMock.mockReturnValue(child)
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const result = serveOrcaApp({
      pairingAddress: 'wss://sandbox.example.com',
      recipeJson: true,
      projectRoot: '/workspace/repo'
    })
    queueMicrotask(() => {
      child.stdout.emit(
        'data',
        '{"schemaVersion":1,"pairingCode":"orca://pair?code=abc","projectRoot":"/workspace/repo"}\n'
      )
    })

    await expect(result).resolves.toBe(0)

    expect(spawnMock).toHaveBeenCalledWith(
      '/Applications/Orca.app/Contents/MacOS/Orca',
      [
        '--serve',
        '--serve-pairing-address',
        'wss://sandbox.example.com',
        '--serve-recipe-json',
        '--serve-project-root',
        '/workspace/repo'
      ],
      expect.objectContaining({
        cwd: resolve(__dirname, '../../..'),
        detached: true,
        stdio: ['ignore', 'pipe', 'inherit']
      })
    )
    expect(writeSpy).toHaveBeenCalledWith(
      '{"schemaVersion":1,"pairingCode":"orca://pair?code=abc","projectRoot":"/workspace/repo"}\n'
    )
    expect(child.unref).toHaveBeenCalled()
  })

  it('uses a shell when a Windows npm command shim is the Electron executable', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.ORCA_APP_EXECUTABLE = 'C:\\repo\\node_modules\\.bin\\electron.cmd'
    const child = {
      kill: vi.fn(),
      once: vi.fn(
        (event: string, handler: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            queueMicrotask(() => handler(0, null))
          }
          return child
        }
      )
    }
    spawnMock.mockReturnValue(child)

    try {
      await expect(serveOrcaApp({ json: true })).resolves.toBe(0)
      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\repo\\node_modules\\.bin\\electron.cmd',
        ['--serve', '--serve-json'],
        expect.objectContaining({
          shell: true
        })
      )
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor)
      }
    }
  })
})

describe('launchOrcaApp', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  afterEach(() => {
    delete process.env.ORCA_OPEN_COMMAND
    delete process.env.ORCA_APP_EXECUTABLE
    delete process.env.ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT
  })

  it('handles asynchronous detached spawn errors without throwing', async () => {
    process.env.ORCA_APP_EXECUTABLE = '/missing/Orca'
    const child = new FakeChildProcess()
    spawnMock.mockReturnValue(child)

    launchOrcaApp()
    child.emit('error', new Error('ENOENT'))
    await Promise.resolve()

    expect(child.unref).toHaveBeenCalled()
  })
})
