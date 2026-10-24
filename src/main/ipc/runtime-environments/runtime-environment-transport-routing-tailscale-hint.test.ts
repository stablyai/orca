import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPair, publicKeyToBase64 } from '../../../shared/e2ee-crypto'
import { encodePairingOffer, type PairingOffer } from '../../../shared/pairing'
import { addEnvironmentFromPairingCode } from '../../../shared/runtime-environment-store'
import {
  callRuntimeEnvironment,
  subscribeRuntimeEnvironment
} from './runtime-environment-transport-routing'
import { getRuntimeEnvironmentStatus } from './runtime-environment-status-probe'
import { resetSharedControlSupport } from './runtime-environment-shared-control-support'

// Exercise real WebSocket failure paths: status returns ok:false while in-use calls reject.

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

let userDataPath: string

function seedEnvironment(name: string, endpoint: string): string {
  // Use a valid key so failure occurs at socket connection, not key parsing.
  const keyPair = generateKeyPair()
  const offer: PairingOffer = {
    v: 2,
    endpoint,
    deviceToken: 'a'.repeat(48),
    publicKeyB64: publicKeyToBase64(keyPair.publicKey)
  }
  const environment = addEnvironmentFromPairingCode(userDataPath, {
    name,
    pairingCode: encodePairingOffer(offer)
  })
  return environment.id
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-tailscale-hint-'))
})

afterEach(() => {
  resetSharedControlSupport()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('Tailscale hint on remote runtime connection failure', () => {
  it('recommends Tailscale on the settings status probe for a non-tailnet endpoint', async () => {
    const id = seedEnvironment('lan-host', 'ws://127.0.0.1:9')
    const response = await getRuntimeEnvironmentStatus(userDataPath, id, 1000)
    expect(response.ok).toBe(false)
    if (response.ok === false) {
      expect(response.error.message).toContain('connect both devices to Tailscale')
      expect(response.error.message).toContain('https://tailscale.com/download')
    }
  })

  it('gives tailnet-specific guidance on the status probe for a Tailscale endpoint', async () => {
    const id = seedEnvironment('ts-host', 'ws://100.64.0.1:9')
    const response = await getRuntimeEnvironmentStatus(userDataPath, id, 800)
    expect(response.ok).toBe(false)
    if (response.ok === false) {
      expect(response.error.message).toContain('Funnel reverted to tailnet-only')
      expect(response.error.message).not.toContain('https://tailscale.com/download')
    }
  })

  it('augments the thrown error for in-use calls (the toast path)', async () => {
    const id = seedEnvironment('lan-host', 'ws://127.0.0.1:9')
    await expect(callRuntimeEnvironment(userDataPath, id, 'files.read', {}, 1000)).rejects.toThrow(
      /connect both devices to Tailscale/
    )
  })

  it('augments a subscription that fails to connect initially', async () => {
    const id = seedEnvironment('lan-host', 'ws://127.0.0.1:9')
    await expect(
      subscribeRuntimeEnvironment(userDataPath, id, 'files.watch', {}, 1000, {
        onEvent: () => {},
        onClose: () => {}
      })
    ).rejects.toThrow(/connect both devices to Tailscale/)
  })
})
