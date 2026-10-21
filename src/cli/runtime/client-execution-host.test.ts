import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeClient } from './client'
import { addEnvironmentFromPairingCode } from './environments'
import { encodePairingOffer } from '../../shared/pairing'

const SELECTORS = ['ORCA_ENVIRONMENT', 'ORCA_PAIRING_CODE', 'ORCA_REMOTE_PAIRING'] as const
const pairingCode = encodePairingOffer({
  v: 2,
  endpoint: 'ws://127.0.0.1:6768',
  deviceToken: 'fixture-token',
  publicKeyB64: 'fixture-key',
  scope: 'runtime'
})
// Each selector names a real paired server, so honouring it routes there.
const selection = {
  ORCA_ENVIRONMENT: 'other-server',
  ORCA_PAIRING_CODE: pairingCode,
  ORCA_REMOTE_PAIRING: pairingCode
}
const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

/** This server's profile, with another server paired in it; the CLI starts with `env`. */
function serverProfileWith(env: Partial<Record<(typeof SELECTORS)[number], string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'cli-owner-'))
  roots.push(root)
  addEnvironmentFromPairingCode(root, { name: 'other-server', pairingCode })
  vi.stubEnv('ORCA_USER_DATA_PATH', root)
  for (const key of SELECTORS) {
    vi.stubEnv(key, env[key])
  }
  return root
}

it("stays on its own server with an agent's empty selectors, and explicit flags still route", () => {
  // The agent environment sets all three empty so a profile's export cannot win.
  const root = serverProfileWith({
    ORCA_ENVIRONMENT: '',
    ORCA_PAIRING_CODE: '',
    ORCA_REMOTE_PAIRING: ''
  })
  expect(new RuntimeClient().isRemote).toBe(false)
  expect(new RuntimeClient(root, undefined, null, 'other-server').isRemote).toBe(true)
  expect(new RuntimeClient(root, undefined, pairingCode, null).isRemote).toBe(true)
})

it.each(SELECTORS)("follows a person's own %s, as on main", (key) => {
  serverProfileWith({ [key]: selection[key] })
  expect(new RuntimeClient().isRemote).toBe(true)
})
