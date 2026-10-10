import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeClient } from './client'
import { addEnvironmentFromPairingCode } from './environments'
import { encodePairingOffer } from '../../shared/pairing'

const roots: string[] = []
const pairingCode = encodePairingOffer({
  v: 2,
  endpoint: 'ws://127.0.0.1:6768',
  deviceToken: 'fixture-token',
  publicKeyB64: 'fixture-key',
  scope: 'runtime'
})

afterEach(() => {
  vi.unstubAllEnvs()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

function owningHost(): string {
  const root = mkdtempSync(join(tmpdir(), 'cli-owner-'))
  roots.push(root)
  vi.stubEnv('ORCA_CLI_OWNING_HOST', '1')
  vi.stubEnv('ORCA_ENVIRONMENT', undefined)
  vi.stubEnv('ORCA_PAIRING_CODE', undefined)
  vi.stubEnv('ORCA_REMOTE_PAIRING', undefined)
  return root
}

it.each(['ORCA_ENVIRONMENT', 'ORCA_PAIRING_CODE', 'ORCA_REMOTE_PAIRING'])(
  'an owning-host invocation ignores inherited %s',
  (key) => {
    const root = owningHost()
    vi.stubEnv(key, 'stale-shell-selection')
    expect(new RuntimeClient(root).isRemote).toBe(false)
  }
)

it('ignores a valid paired default while preserving explicit targeting and standalone defaults', () => {
  const root = owningHost()
  addEnvironmentFromPairingCode(root, { name: 'other-server', pairingCode })
  vi.stubEnv('ORCA_ENVIRONMENT', 'other-server')
  expect(new RuntimeClient(root).isRemote).toBe(false)
  expect(new RuntimeClient(root, undefined, null, 'other-server').isRemote).toBe(true)
  expect(new RuntimeClient(root, undefined, pairingCode, null).isRemote).toBe(true)
  vi.stubEnv('ORCA_CLI_OWNING_HOST', undefined)
  expect(new RuntimeClient(root).isRemote).toBe(true)
})
