import { closeTestJournalHostDatabases } from '../../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
/** Caller-reserved chat ids identify the conversation before its reply; outcome.sessionId names the session actually created. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../../shared/agent-launch/contracts/agent-launch-operation'
import type { AgentSessionRecordStore } from '../../../agent-session/records/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../../agent-session/records/agent-session-record-store-test-harness'
import type { RpcContext } from '../../core'
import '../../dispatcher'
import {
  CAPABLE_CLIENT,
  STRUCTURED_PREFERENCE,
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore,
  type AgentLaunchRuntimeStub as RuntimeStub
} from './agent-launch.test-fixture'

type StructuredCreateArgs = { envelope: { sessionId: string } }
type StructuredCreateResult =
  | { ok: true; value: { sessionId: string } }
  | { ok: false; refusal: { code: string; message: string } }

const createStructured = vi.hoisted(() =>
  vi.fn(async (args: StructuredCreateArgs): Promise<StructuredCreateResult> => ({
    ok: true,
    value: { sessionId: args.envelope.sessionId }
  }))
)

vi.mock('../structured-sessions/creation/structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: createStructured
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')

const SESSION_ID = 'claude_9b1deb4d_3b7d_4bad_9bdd_2b0d7b3dcb6d'
const EXISTING_LAUNCH = { agent: 'claude', target: { kind: 'existing', worktree: 'id:wt-7' } }
const TAKEN = { ok: false as const, refusal: { code: 'agent_session_conflict', message: 'taken' } }

async function launch(params: unknown, runtime: RuntimeStub, context: Partial<RpcContext> = {}) {
  const parsed = AGENT_LAUNCH.params.safeParse(params)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'invalid')
  }
  return AGENT_LAUNCH.handler(parsed.data, rpcContext(runtime, { ...CAPABLE_CLIENT, ...context }))
}

beforeEach(() => {
  createStructured.mockClear()
})

describe('a taken session id under a named operation', () => {
  // The ledger admits against `Date.now()`, so the id must be dated now.
  const OPERATION_ID = `${Date.now()}-000000000000000000000000000000cc`
  let directory: string
  let store: AgentSessionRecordStore

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-session-'))
    store = await openTestAgentSessionRecordStore(directory)
    setAgentLaunchRecordStore(store)
  })

  afterEach(async () => {
    setAgentLaunchRecordStore(null)
    await closeTestJournalHostDatabases()
    await rm(directory, { recursive: true, force: true })
  })

  function outcomeOf(operationId: string) {
    return store.listOperationRows().find((row) => row.operationId === operationId)?.outcome
  }

  it('records the refusal as a failure, so a retry is answered rather than left unknown', async () => {
    createStructured.mockResolvedValueOnce(TAKEN)
    const params = { ...EXISTING_LAUNCH, sessionId: SESSION_ID, operationId: OPERATION_ID }

    await expect(launch(params, runtimeStub({ settings: STRUCTURED_PREFERENCE }))).rejects.toThrow(
      'agent_launch_session_already_exists'
    )
    expect(outcomeOf(OPERATION_ID)).toMatchObject({
      status: 'failed',
      code: 'agent_launch_session_already_exists'
    })

    const retry = runtimeStub({ settings: STRUCTURED_PREFERENCE })
    await expect(launch(params, retry)).rejects.toThrow('agent_launch_session_already_exists')
    expect(createStructured).toHaveBeenCalledTimes(1)
  })
})
