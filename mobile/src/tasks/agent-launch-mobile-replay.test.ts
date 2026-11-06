import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorktreeWithNameRetry } from './worktree-create-retry'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'

import type { AgentSessionRecordStore } from '../../../src/main/runtime/agent-session/records/agent-session-record-store'
import { closeTestJournalHostDatabases } from '../../../src/main/native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { openTestAgentSessionRecordStore } from '../../../src/main/runtime/agent-session/records/agent-session-record-store-test-harness'
import type { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import { RpcDispatcher } from '../../../src/main/runtime/rpc/dispatcher'
import {
  runtimeStub,
  setAgentLaunchRecordStore
} from '../../../src/main/runtime/rpc/methods/agent-launch/agent-launch.test-fixture'

import { stubRpcClient } from '../transport/rpc-client-test-stub'

const createStructuredSession = vi.fn()
vi.mock(
  '../../../src/main/runtime/rpc/methods/structured-sessions/creation/structured-agent-session-create',
  () => ({
    createStructuredAgentSessionForWorktree: (...args: unknown[]) =>
      createStructuredSession(...args)
  })
)
const { AGENT_LAUNCH_METHODS } =
  await import('../../../src/main/runtime/rpc/methods/agent-launch/agent-launch')

let directory: string
let store: AgentSessionRecordStore

beforeEach(async () => {
  createStructuredSession.mockReset()
  createStructuredSession.mockResolvedValue({ ok: true, value: { sessionId: 'session-1' } })
  directory = await mkdtemp(join(tmpdir(), 'orca-mobile-launch-replay-'))
  store = await openTestAgentSessionRecordStore(directory)
  setAgentLaunchRecordStore(store)
})

afterEach(async () => {
  vi.restoreAllMocks()
  setAgentLaunchRecordStore(null)
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

function mobileLaunch(
  args: {
    loseFirstReplyAfterMs?: number
    replay?: boolean
    restartAfterReply?: boolean
    replyLoss?: 'cutover' | 'timeout'
  } = {}
) {
  const runtime = { ...runtimeStub(), getRuntimeId: () => 'runtime-1' }
  const runtimeAfterRestart = { ...runtimeStub(), getRuntimeId: () => 'runtime-2' }
  const dispatchers = [runtime, runtimeAfterRestart].map(
    (host) =>
      new RpcDispatcher({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture implements the launch handler and dispatcher metadata dependencies.
        runtime: host as unknown as OrcaRuntimeService,
        methods: AGENT_LAUNCH_METHODS
      })
  )
  const operationId = `${Date.now()}-000000000000000000000000000000aa`
  const attempts: unknown[] = []
  const client = stubRpcClient({
    getState: () => 'connected',
    sendRequest: async (method: string, params: unknown) => {
      attempts.push(params)
      const dispatcher = dispatchers[args.restartAfterReply && attempts.length > 1 ? 1 : 0]!
      const response = await dispatcher.dispatch({
        id: `request-${attempts.length}`,
        authToken: 'token',
        method,
        params
      })
      if (attempts.length === 1 && args.loseFirstReplyAfterMs !== undefined) {
        const later = Date.now() + args.loseFirstReplyAfterMs
        vi.spyOn(Date, 'now').mockReturnValue(later)
        if (args.replyLoss === 'timeout') {
          throw markRpcDeliveryUnknown(new Error('Request timed out'))
        }
        throw new LogicalClientCutoverError()
      }
      return response
    }
  })
  const result = createWorktreeWithNameRetry({
    client,
    baseName: 'otter',
    buildParams: (name) => ({ repo: 'id:repo-1', name }),
    worktreeCreateIdempotency: { dedupeTtlMs: 60_000 },
    agentLaunch: { agent: 'claude', supported: { replay: args.replay !== false } },
    mintLaunchOperationId: () => operationId
  })
  return { runtime, runtimeAfterRestart, attempts, operationId, result }
}

describe('mobile launch retries through the host ledger', () => {
  it('replays a lost reply beyond the legacy cache window without creating again', async () => {
    const launch = mobileLaunch({ loseFirstReplyAfterMs: 61_000 })

    await expect(launch.result).resolves.toEqual({ worktreeId: 'wt-new', name: 'otter' })
    expect(launch.runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(createStructuredSession).toHaveBeenCalledTimes(1)
    expect(launch.attempts).toHaveLength(2)
    expect(launch.attempts[1]).toEqual(launch.attempts[0])
    expect(launch.runtime.dedupeWorktreeCreate).not.toHaveBeenCalled()
  })
})
