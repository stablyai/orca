import './rpc/unused-default-rpc-methods.test-fixture'
/**
 * "This machine holds a structured chat" against a real host and record store. Session history,
 * resume preparation and replay-safe phone launches all build the host for a user who never had a
 * chat; only a chat record may turn the signal on, and the first one must turn it on at once.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  onStructuredAgentSessionsHeldChanged,
  structuredAgentSessionsHeld
} from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { RpcContext, RpcRequest } from './rpc/core'
import { RpcDispatcher } from './rpc/dispatcher'
import type { OrcaRuntimeService } from './orca-runtime'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

vi.mock('../ai-vault/session-scanner-service-spawn', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanAiVaultSessionsInService: vi.fn(),
  resolveAiVaultSessionTitlesInService: vi.fn()
}))

const { AI_VAULT_METHODS } = await import('./rpc/methods/ai-vault')
const { admitAgentLaunchOperation } = await import('./rpc/methods/agent-launch-replay')

let stateDirectory: string
let heldChanges: boolean[]
let stopListening: () => void

function installHost(): Promise<StructuredAgentSessionHost> {
  return ensureStructuredAgentSessionHost({
    stateDirectory,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => stateDirectory,
    resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true }),
    resolveEnvironment: async () => ({}),
    logger: createStructuredAgentSessionLogger()
  })
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these paths read only the members stubbed here.
const runtime = {
  getRuntimeId: () => 'test-runtime',
  ensureStructuredAgentSessionHost: async () => {
    await installHost()
  },
  listAiVaultSessions: async () => ({
    sessions: [],
    issues: [],
    scannedAt: new Date().toISOString()
  })
} as unknown as OrcaRuntimeService

function operationId(suffix: string): string {
  return `${Date.now()}-${suffix.padStart(32, '0')}`
}

async function recordChat(host: StructuredAgentSessionHost): Promise<void> {
  await host.deps.store.reserveOwner({
    sessionId: 'session-1',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(stateDirectory, 'claude') },
    expectedFence: null,
    spawnToken: 'spawn-1',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'indeterminate', reason: 'no answer' },
    operation: { callerKey: 'desktop', operationId: operationId('c1'), fingerprint: 'fp-1' },
    now: Date.now()
  })
}

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'orca-held-signal-'))
  heldChanges = []
  stopListening = onStructuredAgentSessionsHeldChanged((held) => heldChanges.push(held))
})

afterEach(async () => {
  stopListening()
  await stopStructuredAgentSessionRuntime()
  await rm(stateDirectory, { recursive: true, force: true })
})

describe('whether this machine holds a structured chat', () => {
  it('stays false when Session history builds the host', async () => {
    const dispatcher = new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })
    const request: RpcRequest = { id: 'r1', authToken: 't', method: 'aiVault.listSessions' }

    await expect(dispatcher.dispatch(request)).resolves.toMatchObject({ ok: true })

    expect(structuredAgentSessionsHeld()).toBe(false)
    expect(heldChanges).toEqual([])
  })

  it('stays false when a replay-safe phone launch records its operation', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: admission reads only these fields.
    const context = { runtime, clientKind: 'mobile', pairedDeviceId: 'phone-1' } as RpcContext
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: admission reads only the operation id.
    const params = { operationId: operationId('a1') } as Parameters<
      typeof admitAgentLaunchOperation
    >[1]

    await expect(admitAgentLaunchOperation(context, params, 'fp-launch')).resolves.toMatchObject({
      decision: 'execute'
    })

    expect(structuredAgentSessionsHeld()).toBe(false)
    expect(heldChanges).toEqual([])
  })

  it('turns true when the first chat is created here, without a restart', async () => {
    const host = await installHost()
    expect(structuredAgentSessionsHeld()).toBe(false)

    await recordChat(host)

    expect(structuredAgentSessionsHeld()).toBe(true)
    expect(heldChanges).toEqual([true])
  })

  it('is true as soon as the host restores a saved chat', async () => {
    await recordChat(await installHost())
    await stopStructuredAgentSessionRuntime()
    heldChanges = []

    await installHost()

    expect(structuredAgentSessionsHeld()).toBe(true)
    expect(heldChanges).toEqual([true])
  })
})
