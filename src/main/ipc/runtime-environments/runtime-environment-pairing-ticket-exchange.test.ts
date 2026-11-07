import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import { resolveEnvironmentPairingOffer } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import { PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY } from '../../../shared/remote-runtime/pairing/ticket-exchange-capability'
import { verifyAndAddRuntimeEnvironmentFromPairingCode } from './runtime-environment-pairing-verification'

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }))
vi.mock('../../../shared/remote-runtime/remote-runtime-client', () => ({
  sendRemoteRuntimeRequest: sendMock
}))

const pairingCode = encodePairingOffer({
  v: 2,
  endpoint: 'ws://192.168.1.10:6768',
  deviceToken: 'link-token',
  publicKeyB64: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA='
})

function status(capabilities: string[]) {
  return {
    runtimeId: 'remote-runtime',
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
    capabilities
  }
}

describe('Add server with a pairing link', () => {
  it.each([
    { capabilities: [PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY], exchanged: true },
    { capabilities: [], exchanged: false }
  ])('saves an exchanged token only when the host offers it ($exchanged)', async (row) => {
    sendMock
      .mockReset()
      .mockImplementation(async (_connection: unknown, method: string) =>
        method === 'status.get'
          ? { ok: true, result: status(row.capabilities) }
          : { ok: true, result: { deviceId: 'desktop' } }
      )
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-add-server-exchange-'))

    const result = await verifyAndAddRuntimeEnvironmentFromPairingCode(userDataPath, {
      name: 'Studio',
      pairingCode
    })

    expect(result.ok).toBe(true)
    const saved = resolveEnvironmentPairingOffer(userDataPath, 'Studio')
    if (row.exchanged) {
      expect(saved.deviceToken).toMatch(/^[0-9a-f]{48}$/)
      expect(sendMock).toHaveBeenCalledWith(
        expect.anything(),
        'pairing.exchangeTicket',
        { deviceToken: saved.deviceToken },
        expect.any(Number)
      )
    } else {
      expect(saved.deviceToken).toBe('link-token')
      expect(sendMock).toHaveBeenCalledTimes(1)
    }
  })
})
