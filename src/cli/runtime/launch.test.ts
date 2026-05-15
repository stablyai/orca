import { resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

import { serveOrcaApp } from './launch'

describe('serveOrcaApp', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    process.env.ORCA_APP_EXECUTABLE = '/Applications/Orca.app/Contents/MacOS/Orca'
  })

  afterEach(() => {
    delete process.env.ORCA_APP_EXECUTABLE
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
})
