import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatOrcaSessionAddress } from '../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'

import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import {
  ADDRESS_Y,
  createSessionCallerHarness,
  idOf,
  orchestrationRequest,
  resultOf,
  SESSION_X,
  SESSION_Y,
  sessionRecord,
  type SessionCallerHarness
} from './orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

type Row = Record<string, unknown>

const SESSION_Z = testOrcaSessionId('3f9a1c7e-6b2d-4e85-a0c4-9d1e7b3f5a26')
const ADDRESS_Z = formatOrcaSessionAddress(SESSION_Z)

/** Worker Y's two spellings; a chat has only its session address. */
const handle = mintStructuredWorkerHandle()
const paneKey = mintStructuredWorkerPaneKey(SESSION_Y)
const WORKER_SPELLINGS = [
  ['its handle', handle],
  ['its session address', ADDRESS_Y]
] as const

let h: SessionCallerHarness

beforeEach(() => {
  h = createSessionCallerHarness(hostRef)
  h.records.set(SESSION_Z, sessionRecord(SESSION_Z))
  structuredWorkerIdentities.register({
    handle,
    sessionId: SESSION_Y,
    agent: 'claude',
    paneKey,
    processIncarnation: structuredWorkerProcessIncarnation(SESSION_Y),
    worktreeId: 'wt_1',
    hostScope: { kind: 'local', hostId: 'local' }
  })
})

afterEach(() => {
  h.close()
  vi.restoreAllMocks()
})

function call(sessionId: string | undefined, method: string, params: Row) {
  return h.dispatch(orchestrationRequest(method, params, { sessionId }))
}

async function as(sessionId: string | undefined, method: string, params: Row): Promise<Row> {
  return resultOf(await call(sessionId, method, params))
}

function chatRun(sessionId = SESSION_X): Promise<string> {
  return as(sessionId, 'orchestration.runCreate', { objective: 'o' }).then(({ run }) => idOf(run))
}

/** Worker Y assigned a Dispatch in `runId`, as `worker-start` leaves it. */

/** The PTY terminal assigned a Dispatch in a Run, so it may ask that Run's coordinator. */

describe('every target param resolves both spellings of a party to one canonical address', () => {
  it.each(WORKER_SPELLINGS)(
    'dispatch: a worker named by %s is the assignee, and its check reads the Dispatch',
    async (_l, to) => {
      const runId = await chatRun()
      const task = h.db.createTask({ runId, spec: 'work' })

      const { dispatch } = await as(SESSION_X, 'orchestration.dispatch', { task: task.id, to })

      expect(dispatch).toMatchObject({
        assignee_handle: handle,
        assignee_orca_session_id: SESSION_Y
      })
      expect(await as(SESSION_Y, 'orchestration.check', { peek: true })).toMatchObject({
        dispatchId: idOf(dispatch)
      })
    }
  )

  it('dispatch: a chat named by its session address is the assignee, by its Orca session ID', async () => {
    const runId = await chatRun()
    const task = h.db.createTask({ runId, spec: 'work' })

    const { dispatch } = await as(SESSION_X, 'orchestration.dispatch', {
      task: task.id,
      to: ADDRESS_Z
    })

    expect(dispatch).toMatchObject({
      assignee_handle: ADDRESS_Z,
      assignee_orca_session_id: SESSION_Z,
      assignee_pane_key: null,
      process_incarnation: null
    })
    expect(await as(SESSION_Z, 'orchestration.check', { peek: true })).toMatchObject({
      dispatchId: idOf(dispatch)
    })
  })
})
