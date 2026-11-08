import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'zod'
import type { OrchestrationCompatibilityEvidence } from '../../../shared/orchestration-compatibility-evidence'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../shared/orchestration-session-caller-codes'
import { DeviceRegistry } from './server/pairing/device-registry'
import { OrcaRuntimeRpcServer } from './server/runtime-rpc'
import './core'
import './methods/orchestration/orchestration'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import {
  ADDRESS_X,
  createSessionCallerHarness,
  orchestrationRequest,
  idOf,
  resultOf,
  SESSION_X,
  SESSION_Y,
  sessionRecord,
  type SessionCallerHarness
} from './orchestration-session-caller-test-fixture'
import './orchestration-session-caller'
import '../orchestration/addressing/orchestration-party'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

describe('orchestration session callers at the dispatch entry', () => {
  let h: SessionCallerHarness

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  it('admits the session on the real Unix-socket route and refuses it on the real paired route', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-session-caller-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: h.runtime,
      userDataPath,
      enableWebSocket: false
    })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const device = server['deviceRegistry'].addDevice('laptop', 'runtime')
    const request = orchestrationRequest(
      'orchestration.runCreate',
      { objective: 'o' },
      {
        sessionId: SESSION_X
      }
    )

    const replies: string[] = []
    await server['handleWebSocketMessage'](
      JSON.stringify({ ...request, deviceToken: device.token }),
      (reply) => replies.push(reply),
      () => {},
      undefined,
      undefined,
      device.token
    )
    expect(JSON.parse(replies[0] ?? '{}')).toMatchObject({
      ok: false,
      error: { code: CODES.hostBoundary }
    })

    const local = await server['handleMessage'](
      JSON.stringify({ ...request, authToken: server['authToken'] })
    )
    expect(local).toMatchObject({ ok: true, result: { run: { objective: 'o' } } })
    expect(
      h.db.getCurrentRunForCoordinator({
        terminalHandle: null,
        paneKey: null,
        orcaSessionId: SESSION_X
      })
    ).toMatchObject({ objective: 'o', coordinator_orca_session_id: SESSION_X })
  })

  describe('refuses a session that cannot act, before any destructive or consuming lookup', () => {
    function seedPendingMail(): { runId: string; messageId: string } {
      const run = h.db.createRun({
        objective: 'x',
        coordinatorHandle: null,
        coordinatorPaneKey: null,
        coordinatorOrcaSessionId: SESSION_X
      })
      const message = h.db.insertMessage({
        from: 'term_worker',
        to: ADDRESS_X,
        subject: 'pending',
        body: '',
        runId: run.id
      })
      return { runId: run.id, messageId: message.id }
    }

    async function expectRefusedWithNoEffects(
      sessionId: string,
      code: string,
      message: RegExp,
      evidence?: OrchestrationCompatibilityEvidence
    ): Promise<void> {
      const { messageId } = seedPendingMail()
      for (const [method, params] of [
        ['orchestration.check', {}],
        ['orchestration.reset', { messages: true }]
      ] as const) {
        const response = await h.dispatch(
          orchestrationRequest(method, params, { sessionId, evidence })
        )
        expect(response, method).toMatchObject({
          ok: false,
          error: { code, message: expect.stringMatching(message) }
        })
      }
      expect(h.db.getMessageById(messageId)).toMatchObject({ read: 0 })
    }

    it('a released lease reading its mail, while its background commands still send as it', async () => {
      h.records.set(SESSION_X, sessionRecord(SESSION_X, { lease: { claimStatus: 'released' } }))
      const { messageId } = seedPendingMail()
      for (const [method, params] of [
        ['orchestration.check', {}],
        ['orchestration.check', { wait: true, timeoutMs: 1 }],
        ['orchestration.check', { peek: true }],
        ['orchestration.ask', { question: 'q', to: 'term_worker', timeoutMs: 1 }]
      ] as const) {
        const response = await h.dispatch(
          orchestrationRequest(method, params, { sessionId: SESSION_X })
        )
        expect(response, method).toMatchObject({
          ok: false,
          error: { code: CODES.notLive, message: expect.stringMatching(/is not running right now/) }
        })
      }
      expect(h.db.getMessageById(messageId)).toMatchObject({ read: 0 })

      const sent = await h.dispatch(
        orchestrationRequest(
          'orchestration.send',
          { to: ADDRESS_X, subject: 'wake' },
          { sessionId: SESSION_X }
        )
      )
      expect(h.db.getMessageById(idOf(resultOf(sent).message))).toMatchObject({
        from_handle: ADDRESS_X
      })
    })

    it('a lease mid owner change', async () => {
      h.records.set(
        SESSION_X,
        sessionRecord(SESSION_X, {
          lease: { handoffStage: 'new-owner-proving', handoffOperationId: 'op' }
        })
      )
      await expectRefusedWithNoEffects(SESSION_X, CODES.notLive, /is changing owners/)
    })

    it('a session whose record says it runs on another host', async () => {
      h.records.set(
        SESSION_X,
        sessionRecord(SESSION_X, { location: { executionHostId: 'ssh:devbox' } })
      )
      await expectRefusedWithNoEffects(SESSION_X, CODES.hostBoundary, /runs on another host/)
    })

    it('a structured worker session whose worker identity this host no longer has', async () => {
      // A Dispatch recorded the session as a worker; no registry entry or custody row maps it now.
      const run = h.db.createRun({
        objective: 'pty',
        coordinatorHandle: 'term_c',
        coordinatorPaneKey: 'tab_c:13131313-1313-4313-8313-131313131313'
      })
      h.db.createDispatchContext({
        taskId: h.db.createTask({ runId: run.id, spec: 'work' }).id,
        assigneeHandle: mintStructuredWorkerHandle(),
        assigneePaneKey: mintStructuredWorkerPaneKey(SESSION_Y),
        processIncarnation: structuredWorkerProcessIncarnation(SESSION_Y),
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER
      })

      const response = await h.dispatch(
        orchestrationRequest(
          'orchestration.runCreate',
          { objective: 'o' },
          { sessionId: SESSION_Y }
        )
      )

      expect(response).toMatchObject({
        ok: false,
        error: { code: CODES.notLive, message: expect.stringContaining('no longer has') }
      })
      expect(
        h.db.listRuns().runs.filter((row) => row.coordinator_orca_session_id !== null)
      ).toEqual([])
    })
  })

  describe('a declared caller must name the session', () => {
    it('refuses a declared terminal handle that is not the session', async () => {
      const response = await h.dispatch(
        orchestrationRequest(
          'orchestration.runCreate',
          { objective: 'o', from: 'term_sibling' },
          { sessionId: SESSION_X }
        )
      )
      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'consumer_fenced',
          message: `This caller is agent session ${SESSION_X} and cannot act as term_sibling. No effects were applied.`
        }
      })
      expect(h.db.listRuns().runs.filter((run) => run.legacy === 0)).toEqual([])
    })

    it('accepts a /clear successor naming the address it had before the clear, and no other', async () => {
      // Y continued X after a /clear, so X's address is Y's: the lineage root names the chat.
      h.records.set(SESSION_X, {
        ...sessionRecord(SESSION_X),
        conversationCommand: {
          command: 'clear',
          state: 'completed',
          replacementSessionId: SESSION_Y,
          operationId: 'op',
          callerKey: 'caller',
          phase: 'committed'
        }
      })
      const run = resultOf(
        await h.dispatch(
          orchestrationRequest(
            'orchestration.runCreate',
            { objective: 'o', from: ADDRESS_X },
            { sessionId: SESSION_Y }
          )
        )
      ).run
      expect(h.db.getRunRaw(idOf(run))?.coordinator_orca_session_id).toBe(SESSION_X)

      const stranger = 'orca_session_id:0b5e2d7c-9a41-4c3e-8f62-7d1a3e5b9c08'
      const refused = await h.dispatch(
        orchestrationRequest(
          'orchestration.runCreate',
          { objective: 'o', from: stranger },
          { sessionId: SESSION_Y }
        )
      )
      expect(refused).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
    })
  })
})
