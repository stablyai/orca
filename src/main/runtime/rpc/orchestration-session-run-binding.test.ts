import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../structured-worker-identity'
import {
  createSessionCallerHarness,
  orchestrationRequest,
  resultOf,
  idOf,
  SESSION_X,
  SESSION_Y,
  type SessionCallerHarness
} from './orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

function deliveryId(result: Record<string, unknown>): string {
  if (typeof result.deliveryId === 'string') {
    return result.deliveryId
  }
  throw new Error('Expected a Delivery')
}

describe('structured lead Run binding through the RPC dispatcher', () => {
  let h: SessionCallerHarness
  let dispatchId: string

  function call(sessionId: string, method: string, params: Record<string, unknown> = {}) {
    return h
      .dispatch(orchestrationRequest(`orchestration.${method}`, params, { sessionId }))
      .then(resultOf)
  }

  beforeEach(async () => {
    h = createSessionCallerHarness(hostRef)
    const handle = mintStructuredWorkerHandle()
    const paneKey = mintStructuredWorkerPaneKey(SESSION_Y)
    structuredWorkerIdentities.register({
      handle,
      sessionId: SESSION_Y,
      agent: 'claude',
      paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_Y),
      worktreeId: 'folder-workspace',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    const runId = idOf((await call(SESSION_X, 'runCreate', { objective: 'parent' })).run)
    dispatchId = h.db.createDispatchContext({
      taskId: h.db.createTask({ runId, spec: 'structured lead' }).id,
      assigneeHandle: handle,
      assigneePaneKey: paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_Y),
      creator: { kind: 'session', orcaSessionId: SESSION_X },
      maxDepth: Number.MAX_SAFE_INTEGER
    }).id
  })
  afterEach(() => {
    h.runtime.cancelMessageWaiters(`dispatch:${dispatchId}`)
    h.close()
    vi.restoreAllMocks()
  })

  it.each(['runCreate', 'runUse'] as const)(
    'cancels a parked session Dispatch check on %s',
    async (method) => {
      const params =
        method === 'runCreate'
          ? { objective: 'child' }
          : {
              id: h.db.createRun({
                objective: 'unbound',
                coordinatorHandle: null,
                coordinatorPaneKey: null
              }).id
            }
      const wait = vi.spyOn(h.runtime, 'waitForMessage')
      const waiting = call(SESSION_Y, 'check', { wait: true, timeoutMs: 500 })
      await vi.waitFor(() =>
        expect(wait).toHaveBeenCalledWith(`dispatch:${dispatchId}`, expect.anything())
      )
      const child = idOf((await call(SESSION_Y, method, params)).run)
      expect(await waiting).toMatchObject({ cancelled: true, timedOut: false })
      const sent = await call(SESSION_X, 'send', {
        to: `dispatch:${dispatchId}`,
        subject: 'after bind'
      })
      expect(sent.message).toMatchObject({ to_handle: `run:${child}`, run_id: child })
      expect(await call(SESSION_Y, 'check')).toMatchObject({
        messages: [{ subject: 'after bind' }]
      })
      expect(h.db.getInbox()).toHaveLength(1)
    }
  )

  it.each(['cancel', 'throw'] as const)(
    'replays a pre-bind ack receipt after the following wait ends by %s',
    async (ending) => {
      await call(SESSION_X, 'send', { to: `dispatch:${dispatchId}`, subject: 'ack me' })
      const ack = deliveryId(await call(SESSION_Y, 'check'))
      const acknowledge = vi.spyOn(h.db, 'acknowledgeMailboxDelivery')
      const wait = vi.spyOn(h.runtime, 'waitForMessage').mockImplementationOnce(async () => {
        await call(SESSION_Y, 'runCreate', { objective: 'child' })
        if (ending === 'throw') {
          throw new Error('wait transport interrupted')
        }
        return 'cancelled'
      })
      const request = orchestrationRequest(
        'orchestration.check',
        { ack, wait: true, timeoutMs: 500 },
        {
          sessionId: SESSION_Y,
          requestId: `bind-during-ack-${ending}`
        }
      )
      const first = await h.dispatch(request)
      if (ending === 'throw') {
        expect(first).toMatchObject({ ok: false, error: { code: 'runtime_error' } })
      } else {
        expect(resultOf(first)).toMatchObject({ acknowledged: ack, count: 0, cancelled: true })
      }
      const replay = resultOf(await h.dispatch(request))
      expect(replay).toMatchObject({ acknowledged: ack, count: 0, mutation: { replayed: true } })
      if (ending === 'throw') {
        expect(replay.waitInterrupted).toBe('outcome_unknown')
      }
      expect(acknowledge).toHaveBeenCalledTimes(1)
      expect(wait).toHaveBeenCalledTimes(1)
      expect(h.db.getDeliveryRaw(ack)?.status).toBe('acknowledged')
    }
  )
})
