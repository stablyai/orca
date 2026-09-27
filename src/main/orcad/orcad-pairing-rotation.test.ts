import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  installOrcadPairingRotation,
  ORCAD_PAIRING_OFFER_FILENAME,
  ORCAD_PAIRING_ROTATION_SIGNAL,
  rotateOrcadPairingOffer
} from './orcad-pairing-rotation'

const SECRET_URL = 'orca://pair?code=SECRET-TOKEN'

function availableRpc() {
  return {
    createPairingOffer: vi.fn(() => ({
      available: true as const,
      pairingUrl: SECRET_URL,
      endpoint: 'wss://runner.example.ts.net:6768',
      deviceId: 'device-2',
      webClientUrl: null
    }))
  }
}

describe('rotateOrcadPairingOffer', () => {
  it('rotates the pending runtime offer and writes it to the data root', () => {
    const rpc = availableRpc()
    const write = vi.fn(() => true)
    const log = vi.fn()
    const ok = rotateOrcadPairingOffer({
      rpc,
      userDataPath: '/data',
      pairingAddress: 'wss://runner.example.ts.net:6768',
      now: () => new Date('2026-09-26T21:00:00Z'),
      write,
      log
    })

    expect(ok).toBe(true)
    expect(rpc.createPairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        address: 'wss://runner.example.ts.net:6768',
        scope: 'runtime',
        rotate: true
      })
    )
    expect(write).toHaveBeenCalledWith(join('/data', ORCAD_PAIRING_OFFER_FILENAME), {
      type: 'orca_pairing_offer',
      available: true,
      createdAt: '2026-09-26T21:00:00.000Z',
      deviceId: 'device-2',
      endpoint: 'wss://runner.example.ts.net:6768',
      url: SECRET_URL
    })
  })

  it('never logs the pairing link', () => {
    const log = vi.fn()
    rotateOrcadPairingOffer({ rpc: availableRpc(), userDataPath: '/data', write: () => true, log })
    expect(log.mock.calls.flat().join('\n')).not.toContain('SECRET-TOKEN')
  })

  it('records why when no offer can be made', () => {
    const write = vi.fn(() => true)
    const rpc = {
      createPairingOffer: vi.fn(() => ({
        available: false as const,
        reason: 'websocket_unavailable' as const,
        guidance: 'choose another port'
      }))
    }
    expect(rotateOrcadPairingOffer({ rpc, userDataPath: '/data', write, log: vi.fn() })).toBe(false)
    expect(write).toHaveBeenCalledWith(join('/data', ORCAD_PAIRING_OFFER_FILENAME), {
      type: 'orca_pairing_offer',
      available: false,
      reason: 'websocket_unavailable',
      guidance: 'choose another port'
    })
  })

  it('warns when the file permissions could not be restricted', () => {
    const log = vi.fn()
    rotateOrcadPairingOffer({ rpc: availableRpc(), userDataPath: '/data', write: () => false, log })
    expect(log.mock.calls.flat().join('\n')).toContain('could not restrict permissions')
  })
})

describe('installOrcadPairingRotation', () => {
  it('rotates on SIGUSR2 and stops after uninstall', () => {
    const target = new EventEmitter()
    const rpc = availableRpc()
    const uninstall = installOrcadPairingRotation({
      rpc,
      userDataPath: '/data',
      platform: 'linux',
      target,
      write: () => {
        throw new Error('disk full')
      },
      log: vi.fn()
    })
    // A failing write must be swallowed: an operator hook never crashes the server.
    expect(() => target.emit(ORCAD_PAIRING_ROTATION_SIGNAL)).not.toThrow()
    expect(rpc.createPairingOffer).toHaveBeenCalledTimes(1)
    uninstall()
    target.emit(ORCAD_PAIRING_ROTATION_SIGNAL)
    expect(rpc.createPairingOffer).toHaveBeenCalledTimes(1)
  })

  it('does nothing on Windows, which has no SIGUSR2', () => {
    const target = new EventEmitter()
    installOrcadPairingRotation({
      rpc: availableRpc(),
      userDataPath: '/data',
      platform: 'win32',
      target
    })
    expect(target.listenerCount(ORCAD_PAIRING_ROTATION_SIGNAL)).toBe(0)
  })
})
