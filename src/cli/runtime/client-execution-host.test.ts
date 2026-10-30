import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RuntimeClient } from './client'
import { addEnvironmentFromPairingCode } from './environments'
import { encodePairingOffer } from '../../shared/pairing'
import { getRuntimeMetadataPath, type RuntimeMetadata } from '../../shared/runtime-bootstrap'

const transport = vi.hoisted(() => ({ local: vi.fn(), remote: vi.fn() }))

vi.mock('./transport', () => ({ sendRequest: transport.local }))
vi.mock('./websocket-transport', () => ({ sendWebSocketRequest: transport.remote }))

const SELECTORS = ['ORCA_ENVIRONMENT', 'ORCA_PAIRING_CODE', 'ORCA_REMOTE_PAIRING'] as const
const publicKeyB64 = Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
const pairingCode = encodePairingOffer({
  v: 2,
  endpoint: 'ws://127.0.0.1:6768',
  deviceToken: 'fixture-token',
  publicKeyB64,
  scope: 'runtime'
})
const selection = {
  ORCA_ENVIRONMENT: 'other-server',
  ORCA_PAIRING_CODE: pairingCode,
  ORCA_REMOTE_PAIRING: pairingCode
}
const roots: string[] = []

beforeEach(() => {
  vi.clearAllMocks()
  for (const server of ['local', 'remote'] as const) {
    transport[server].mockResolvedValue({
      id: 'request-1',
      ok: true,
      result: { server },
      _meta: { runtimeId: `runtime-${server}` }
    })
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

function serverProfileWith(env: Partial<Record<(typeof SELECTORS)[number], string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'cli-owner-'))
  roots.push(root)
  addEnvironmentFromPairingCode(root, { name: 'other-server', pairingCode })
  const metadata: RuntimeMetadata = {
    runtimeId: 'runtime-local',
    pid: 123,
    transports: [{ kind: 'unix', endpoint: join(root, 'runtime.sock') }],
    authToken: 'local-token',
    startedAt: 1
  }
  writeFileSync(getRuntimeMetadataPath(root), JSON.stringify(metadata))
  vi.stubEnv('ORCA_USER_DATA_PATH', root)
  for (const key of SELECTORS) {
    vi.stubEnv(key, env[key])
  }
  return root
}

async function requestServer(client: RuntimeClient): Promise<string> {
  return (await client.call<{ server: string }>('status.get')).result.server
}

it("stays on its own server with an agent's empty selectors, and explicit flags still route", async () => {
  // Empty selectors prevent profile exports from routing the agent to another server.
  const root = serverProfileWith({
    ORCA_ENVIRONMENT: '',
    ORCA_PAIRING_CODE: '',
    ORCA_REMOTE_PAIRING: ''
  })
  expect(await requestServer(new RuntimeClient())).toBe('local')
  expect(transport.remote).not.toHaveBeenCalled()
  expect(transport.local).toHaveBeenCalledWith(
    expect.objectContaining({ runtimeId: 'runtime-local', authToken: 'local-token' }),
    'status.get',
    undefined,
    60_000,
    expect.anything(),
    undefined,
    undefined
  )
  expect(await requestServer(new RuntimeClient(root, undefined, null, 'other-server'))).toBe(
    'remote'
  )
  expect(await requestServer(new RuntimeClient(root, undefined, pairingCode, null))).toBe('remote')
})

it.each(SELECTORS)("routes requests through a person's own %s", async (key) => {
  serverProfileWith({ [key]: selection[key] })
  expect(await requestServer(new RuntimeClient())).toBe('remote')
  expect(transport.local).not.toHaveBeenCalled()
  expect(transport.remote).toHaveBeenCalledWith(
    {
      endpoint: 'ws://127.0.0.1:6768',
      hostPublicKeyB64: publicKeyB64,
      credential: { kind: 'token', deviceToken: 'fixture-token' }
    },
    'status.get',
    undefined,
    60_000,
    expect.anything()
  )
})
