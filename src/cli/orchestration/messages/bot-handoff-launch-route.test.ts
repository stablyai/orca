// @orca-isolated-worker: the CLI selects inline environment-store ownership for this process.
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import {
  closeAdmittedEnvironmentStore,
  useInlineEnvironmentStoreForCli
} from '../../../shared/remote-runtime/host-store/runtime-environment-store-execution'
import { addEnvironmentFromPairingCode } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import { main } from '../../index'

let profile: string
let pairingCode: string
const connections: string[] = []
const server = createServer((socket) => {
  connections.push('connected')
  socket.destroy()
})
beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), 'orca-handoff-route-'))
  useInlineEnvironmentStoreForCli()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing fixture port')
  }
  pairingCode = encodePairingOffer({
    v: 2,
    scope: 'runtime',
    endpoint: `ws://127.0.0.1:${address.port}`,
    publicKeyB64: Buffer.alloc(32, 7).toString('base64'),
    deviceToken: 'fixture-token'
  })
  await addEnvironmentFromPairingCode(profile, { name: 'fixture', pairingCode })
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeAdmittedEnvironmentStore()
  await rm(profile, { recursive: true, force: true })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

test.each([
  { args: ['--environment', 'fixture'], env: undefined },
  { args: ['--pairing-code', 'fixture'], env: undefined },
  { args: [], env: 'ORCA_ENVIRONMENT' },
  { args: [], env: 'ORCA_PAIRING_CODE' },
  { args: [], env: 'ORCA_REMOTE_PAIRING' }
])('a CLI handoff override refuses remote selection $args $env', async ({ args, env }) => {
  for (const key of [
    'ORCA_ENVIRONMENT',
    'ORCA_PAIRING_CODE',
    'ORCA_REMOTE_PAIRING',
    'ORCA_AGENT_SESSION_ID',
    'ORCA_AGENT_LAUNCH_TOKEN',
    'ORCA_USER_DATA_PATH'
  ]) {
    vi.stubEnv(
      key,
      key === env ? (key === 'ORCA_ENVIRONMENT' ? 'fixture' : pairingCode) : undefined
    )
  }
  vi.stubEnv('ORCA_USER_DATA_PATH', profile)
  const result = vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const savedExitCode = process.exitCode
  connections.length = 0
  try {
    await main([
      ...(args[0] === '--pairing-code' ? ['--pairing-code', pairingCode] : args),
      'orchestration',
      'send',
      '--from',
      'term_example',
      '--to',
      'bot:example',
      '--type',
      'handoff',
      '--chat',
      'new',
      '--subject',
      'Review the docs',
      '--model',
      'gpt-5.5',
      '--json'
    ])
    const [receipt] = result.mock.lastCall ?? []
    expect({ reply: JSON.parse(String(receipt)), connections }).toMatchObject({
      reply: { ok: false, error: { code: 'capability_unsupported' } },
      connections: []
    })
  } finally {
    process.exitCode = savedExitCode
  }
})
