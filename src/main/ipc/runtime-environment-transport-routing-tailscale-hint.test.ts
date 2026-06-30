import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateKeyPair, publicKeyToBase64 } from '../../shared/e2ee-crypto'
import { encodePairingOffer, type PairingOffer } from '../../shared/pairing'
import { addEnvironmentFromPairingCode } from '../../shared/runtime-environment-store'
import {
  callRuntimeEnvironment,
  getRuntimeEnvironmentStatus,
  subscribeRuntimeEnvironment
} from './runtime-environment-transport-routing'

// Why: prove the wiring, not just the helper — an unreachable endpoint exercises
// the real WebSocket failure → reject → Tailscale-hint join points the settings
// probe (returned ok:false) and in-use calls (thrown) actually use.

let userDataPath: string

function seedEnvironment(name: string, endpoint: string): string {
  // A valid Curve25519 public key lets the client reach the socket-connect step
  // (and fail there) instead of bailing out early on key parsing.
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
