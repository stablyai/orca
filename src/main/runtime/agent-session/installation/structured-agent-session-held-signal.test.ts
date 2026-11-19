/** Opening the store for history/resume/phone admission does not prove chat presence; the first chat record must update the signal immediately. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  onStructuredAgentSessionsHeldChanged,
  structuredAgentSessionsHeld
} from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import type { RpcRequest } from '../../rpc/core'

import { RpcDispatcher } from '../../rpc/dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { stopStructuredAgentSessionRuntime } from './structured-agent-session-runtime'
import { ensureTestStructuredAgentSessionHost as ensureStructuredAgentSessionHost } from '../records/agent-session-record-store-test-harness'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { openAgentSessionRecordStoreOnce } from '../records/agent-session-record-store-slot'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from '../../../native-chat/agent-session-journal/journal-sql-worker-bundle.test-fixture'

vi.mock('../../../ai-vault/scan-service/session-scanner-service-spawn', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanAiVaultSessionsInService: vi.fn(),
  resolveAiVaultSessionTitlesInService: vi.fn()
}))

const { AI_VAULT_METHODS } = await import('../../rpc/methods/history/ai-vault')
await import('../../rpc/methods/agent-launch/agent-launch-replay')

let stateDirectory: string
let heldChanges: boolean[]
let stopListening: () => void

function installHost(): Promise<StructuredAgentSessionHost> {
  return ensureStructuredAgentSessionHost({
    stateDirectory,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => stateDirectory,
    resolveLaunchArgs: () => [],
    resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
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
  openAgentSessionRecordStore: async () =>
    (
      await openAgentSessionRecordStoreOnce({
        legacySessionTabIds: [],
        stateDirectory,
        hostId: 'local',
        logger: createStructuredAgentSessionLogger(),
        writerPath: journalSqlWorkerPath(),
        readerPath: journalSqlReaderPath(),
        onMaintenanceTick: () => {}
      })
    ).store,
  listAiVaultSessions: async () => ({
    sessions: [],
    issues: [],
    scannedAt: new Date().toISOString()
  })
} as unknown as OrcaRuntimeService

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
})
