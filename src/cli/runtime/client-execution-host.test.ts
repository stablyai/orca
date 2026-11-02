import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RuntimeClient } from './client'
import { addEnvironmentFromPairingCode } from './environments'
import { encodePairingOffer } from '../../shared/pairing'
import { getRuntimeMetadataPath, type RuntimeMetadata } from '../../shared/runtime-bootstrap'

const transport = vi.hoisted(() => ({ local: vi.fn(), remote: vi.fn(), remotePreflight: vi.fn() }))

vi.mock('./transport', () => ({ sendRequest: transport.local }))
vi.mock('./websocket-transport', () => ({
  sendWebSocketRequest: transport.remote,
  sendWebSocketRequestWithStatusPreflight: transport.remotePreflight
}))

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
  for (const server of ['local', 'remote', 'remotePreflight'] as const) {
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

const CALLER_CHAT = 'codex_6cba3e14_b1a0_4b36_8f25_96c0dfa39fbb'

// A native chat's agent has its session id but no terminal handle, pane key or launch token.
function nativeChatEnv(extra: Record<string, string> = {}): void {
  vi.stubEnv('ORCA_AGENT_SESSION_ID', CALLER_CHAT)
  for (const key of ['ORCA_TERMINAL_HANDLE', 'ORCA_PANE_KEY', 'ORCA_AGENT_LAUNCH_TOKEN']) {
    vi.stubEnv(key, undefined)
  }
  for (const [key, value] of Object.entries(extra)) {
    vi.stubEnv(key, value)
  }
}

async function evidenceSent(client: RuntimeClient, method: string): Promise<unknown> {
  transport.local.mockClear()
  await client.call(method, {})
  return transport.local.mock.calls[0]?.[4]?.orchestrationCompatibilityEvidence
}

it('names the launching chat on launches from a native chat, and on nothing else', async () => {
  const root = serverProfileWith({})
  nativeChatEnv()
  const client = new RuntimeClient(root)

  expect(await evidenceSent(client, 'agent.launchReplay')).toEqual({ agentSessionId: CALLER_CHAT })
  expect(await evidenceSent(client, 'agent.launch')).toEqual({ agentSessionId: CALLER_CHAT })
  expect(await evidenceSent(client, 'terminal.list')).toBeUndefined()
})

it('names no chat from a WSL session, whose id this host cannot resolve', async () => {
  const root = serverProfileWith({})
  nativeChatEnv({
    ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND: 'wsl',
    ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID: 'wsl-host',
    ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION: 'Ubuntu'
  })

  expect(await evidenceSent(new RuntimeClient(root), 'agent.launchReplay')).toBeUndefined()
})

it('names no chat to a paired server', async () => {
  serverProfileWith({ ORCA_PAIRING_CODE: pairingCode })
  nativeChatEnv()

  await new RuntimeClient().call('agent.launchReplay', {})
  expect(transport.local).not.toHaveBeenCalled()
  expect(transport.remotePreflight.mock.calls[0]?.[5]).not.toHaveProperty(
    'orchestrationCompatibilityEvidence'
  )
})
