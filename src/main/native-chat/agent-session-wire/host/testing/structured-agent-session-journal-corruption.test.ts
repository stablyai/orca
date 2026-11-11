import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionRecordStore } from '../../../../runtime/agent-session/records/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from '../../providers/structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from '../structured-agent-session-host'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION, HOST_TEST_THREAD } from './structured-agent-session-host-test-data'

let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']>
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>

beforeEach(() => {
  ;({ store, host, cancelTurn, acquire } = hostTestState())
})

async function runningTurn(): Promise<void> {
  await attach()
  acquire.mock.calls
    .at(-1)![0]
    .events!.appendItem(
      { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'turn-1', ordinal: 900 },
      { kind: 'turn', turnId: 'turn-1', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  await host.flushStreamedEvents(HOST_TEST_SESSION)
}

afterEach(() => vi.restoreAllMocks())

const sqliteError = (message: string, errcode: number): Error =>
  Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode })

const stop = (turnEnvelope = envelope('agentSession.cancel', { turnId: 'turn-1' })) =>
  host.cancel(CALLER, { envelope: turnEnvelope, turnId: 'turn-1' })

it('replays a recorded Stop from its receipt when its ledger cannot be written', async () => {
  await runningTurn()
  const stopEnvelope = envelope('agentSession.cancel', { turnId: 'turn-1' })
  await expect(stop(stopEnvelope)).resolves.toMatchObject({ ok: true, replayed: false })
  expect(cancelTurn).toHaveBeenCalledTimes(1)
  // Even receipt replay requires the store transaction to succeed.
  vi.spyOn(store, 'admitMutationOperation').mockRejectedValue(
    sqliteError('database disk image is malformed', 11)
  )
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)

  // A repeated interrupt could stop a turn this request never targeted.
  await expect(stop(stopEnvelope)).resolves.toMatchObject({
    ok: true,
    replayed: true,
    value: { turnId: 'turn-1', cancelled: false }
  })
  expect(cancelTurn).toHaveBeenCalledTimes(1)
})
