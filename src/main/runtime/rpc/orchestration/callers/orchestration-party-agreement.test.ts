import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatOrcaSessionAddress } from '../../../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../../../shared/orca-session-address-test-fixture'

import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import {
  ADDRESS_X,
  createSessionCallerHarness,
  idOf,
  orchestrationRequest,
  resultOf,
  SESSION_X,
  SESSION_Y,
  sessionRecord,
  WORKER_HANDLE,
  type SessionCallerHarness
} from './session.test-fixture'

// A `/clear`ed member of X's lineage and of worker Y's, as a later lineage walk will map them.
const ALIAS_X = testOrcaSessionId('5c7e2a94-1d3b-4f68-b9a0-e4c2d6f81b37')
const ALIAS_Y = testOrcaSessionId('8a4d6f20-3e1c-4b79-a5d2-c0f7e9b3a164')

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => hostRef.current
  })
)
vi.mock('../../../orchestration/addressing/session-lineage/canonical-orca-session-id', () => ({
  canonicalOrcaSessionId: (id: string) =>
    id === '5c7e2a94-1d3b-4f68-b9a0-e4c2d6f81b37'
      ? '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
      : id === '8a4d6f20-3e1c-4b79-a5d2-c0f7e9b3a164'
        ? '7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64'
        : id
}))

type Row = Record<string, unknown>

const handle = mintStructuredWorkerHandle()
const paneKey = mintStructuredWorkerPaneKey(SESSION_Y)
let h: SessionCallerHarness

beforeEach(() => {
  h = createSessionCallerHarness(hostRef)
  h.records.set(ALIAS_X, sessionRecord(ALIAS_X))
  h.records.set(ALIAS_Y, sessionRecord(ALIAS_Y))
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

function registerWorker(): void {
  structuredWorkerIdentities.register({
    handle,
    sessionId: SESSION_Y,
    agent: 'claude',
    paneKey,
    processIncarnation: structuredWorkerProcessIncarnation(SESSION_Y),
    worktreeId: 'wt_1',
    hostScope: { kind: 'local', hostId: 'local' }
  })
}

/** A Dispatch naming Y as a structured worker, in a Run a terminal coordinates. */

describe('every session-to-party step goes through the canonical session id', () => {
  it('binds a claimed alias as its canonical session', async () => {
    const { run } = await as(ALIAS_X, 'orchestration.runCreate', { objective: 'o' })
    expect(h.db.getRunRaw(idOf(run))?.coordinator_orca_session_id).toBe(SESSION_X)
    expect(await as(SESSION_X, 'orchestration.runCurrent', {})).toMatchObject({
      run: { id: idOf(run) }
    })
  })

  it("delivers mail to an alias's address at the canonical session's mailbox", async () => {
    const { message } = await as(undefined, 'orchestration.send', {
      from: WORKER_HANDLE,
      to: formatOrcaSessionAddress(ALIAS_X),
      subject: 's'
    })
    expect(message).toMatchObject({ to_handle: ADDRESS_X })
  })

  it("resolves a worker alias's address to the worker's handle", async () => {
    registerWorker()
    const { message } = await as(undefined, 'orchestration.send', {
      from: formatOrcaSessionAddress(ALIAS_Y),
      to: ADDRESS_X,
      subject: 's'
    })
    expect(message).toMatchObject({ from_handle: handle })
  })

  it.each([formatOrcaSessionAddress(ALIAS_X), ALIAS_X])(
    'accepts the session declared as its alias %s',
    async (declared) => {
      const { run } = await as(SESSION_X, 'orchestration.runCreate', {
        objective: 'o',
        from: declared
      })
      expect(run).toMatchObject({ coordinator_handle: null })
    }
  )
})
