import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZodObject } from 'zod'
import type { OrchestrationCompatibilityEvidence } from '../../../shared/orchestration-compatibility-evidence'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../shared/orchestration-session-caller-codes'
import { DeviceRegistry } from '../device-registry'
import { OrcaRuntimeRpcServer } from '../runtime-rpc'
import { buildRegistry } from './core'
import { ORCHESTRATION_METHODS } from './methods/orchestration'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../structured-worker-identity'
import {
  ADDRESS_X,
  createSessionCallerHarness,
  orchestrationRequest,
  PROVIDER_ID_X,
  idOf,
  resultOf,
  SESSION_X,
  SESSION_Y,
  sessionRecord,
  type SessionCallerHarness
} from './orchestration-session-caller-test-fixture'
import {
  needsOrchestrationCallerResolution,
  ORCHESTRATION_CALLER_PARAM
} from './orchestration-session-caller'
import { ORCHESTRATION_TARGET_PARAM } from '../orchestration/orchestration-party'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

// Fields that can name a party: the caller in ORCHESTRATION_CALLER_PARAM, a target in ORCHESTRATION_TARGET_PARAM.
const PARTY_NAMING_FIELDS = ['to', 'from', 'terminal', 'callerTerminalHandle'] as const
// `method field` pairs with such a field that is neither, so never resolves as a party.
const NAMES_NO_RESOLVED_PARTY: Readonly<Record<string, string>> = {
  'orchestration.run from': 'retired; refused before any handler',
  'orchestration.runShow from': 'reads a Run by id; `from` is unused',
  'orchestration.dispatchShow from': '`from` only fills the preview preamble text',
  'orchestration.workerStart terminal': 'adopts an existing PTY pane, which a session never has',
  'orchestration.federationAttachStart terminal': 'names the remote worker terminal',
  'orchestration.workerTerminalUserInput terminal': 'names the worker terminal'
}

/** One request per identity-consulting method, valid enough to reach the dispatcher entry. */
const MINIMAL_PARAMS: Readonly<Record<string, Record<string, unknown>>> = {
  'orchestration.runCreate': { objective: 'o' },
  'orchestration.runUse': { id: 'run_missing' },
  'orchestration.runCurrent': {},
  'orchestration.check': {},
  'orchestration.send': { subject: 's', to: 'term_worker' },
  'orchestration.reply': { id: 'msg_missing', body: 'b' },
  'orchestration.ask': { question: 'q', to: 'term_worker' },
  'orchestration.dispatch': { task: 'task_missing', to: 'term_worker' },
  'orchestration.gateCreate': { task: 'task_missing', question: 'q' },
  'orchestration.gateResolve': { id: 'gate_missing', resolution: 'r' },
  'orchestration.gateList': {},
  'orchestration.taskCreate': { spec: 's' },
  'orchestration.taskList': {},
  'orchestration.taskUpdate': { id: 'task_missing', status: 'completed' },
  'orchestration.workerStart': { spec: 's' }
}

describe('orchestration session callers at the dispatch entry', () => {
  let h: SessionCallerHarness

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  it('classifies every party-naming field as the caller, a resolved target, or neither', () => {
    const registry = buildRegistry(ORCHESTRATION_METHODS)
    const partyNaming = [...registry.values()]
      .flatMap((method) => {
        const schema = method.params
        return schema instanceof ZodObject
          ? PARTY_NAMING_FIELDS.filter((field) => Object.hasOwn(schema.shape, field)).map(
              (field) => `${method.name} ${field}`
            )
          : []
      })
      .sort()

    // The population: 41 registered methods carrying 25 party-naming fields.
    expect(registry.size).toBe(41)
    expect(partyNaming).toHaveLength(25)
    expect(partyNaming).toEqual(
      [
        ...Object.entries(ORCHESTRATION_CALLER_PARAM).map(
          ([method, field]) => `${method} ${field}`
        ),
        ...Object.entries(ORCHESTRATION_TARGET_PARAM).map(
          ([method, field]) => `${method} ${field}`
        ),
        ...Object.keys(NAMES_NO_RESOLVED_PARTY)
      ].sort()
    )
    expect(Object.keys(MINIMAL_PARAMS).sort()).toEqual(
      Object.keys(ORCHESTRATION_CALLER_PARAM).sort()
    )
  })

  it.each(Object.keys(ORCHESTRATION_CALLER_PARAM))(
    'refuses %s from a paired client before any effect, naming the host boundary',
    async (method) => {
      const response = await h.dispatchStreaming(
        orchestrationRequest(method, MINIMAL_PARAMS[method] ?? {}, { sessionId: SESSION_X }),
        'paired-device-1'
      )

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: CODES.hostBoundary,
          message: expect.stringContaining('only on the host that runs that session'),
          data: { effectsApplied: false }
        }
      })
      expect(h.db.listRuns().runs.filter((run) => run.legacy === 0)).toEqual([])
    }
  )

  it.each(Object.keys(ORCHESTRATION_CALLER_PARAM))(
    'resolves %s on the local route as the session, never as a terminal',
    async (method) => {
      const spy = vi.spyOn(h.runtime, 'verifyOrchestrationCompatibilityCaller')
      const response = await h.dispatch(
        orchestrationRequest(method, MINIMAL_PARAMS[method] ?? {}, {
          sessionId: SESSION_X,
          evidence: {
            terminalHandle: 'term_other',
            paneKey: 'tab_other:1:2',
            launchToken: 'secret'
          }
        })
      )

      // Whatever the method answers, it answered as the session: no host-boundary or session refusal,
      // and terminal evidence on the same request never attested anyone.
      if (!response.ok) {
        expect(Object.values(CODES)).not.toContain(response.error.code)
        expect(response.error.message).not.toContain('term_other')
      }
      for (const [evidence] of spy.mock.calls) {
        expect(evidence?.terminalHandle).toBeUndefined()
      }
    }
  )

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

    it('an id that names no Orca session', async () => {
      await expectRefusedWithNoEffects(
        'ffffffff-0000-4000-8000-000000000000',
        CODES.unknown,
        /No Orca agent session .* exists on this host/
      )
    })

    it('a terminal handle presented as a session id', async () => {
      await expectRefusedWithNoEffects('term_4f2c9a0b', CODES.unknown, /not an Orca session id/)
    })

    it("a provider's session id, with a hint naming the Orca id", async () => {
      const response = await h.dispatch(
        orchestrationRequest('orchestration.runCurrent', {}, { sessionId: PROVIDER_ID_X })
      )
      expect(response).toMatchObject({
        ok: false,
        error: {
          code: CODES.providerId,
          message: expect.stringContaining(`This session's Orca id is ${SESSION_X}`),
          data: { orcaSessionId: SESSION_X, effectsApplied: false }
        }
      })
      await expectRefusedWithNoEffects(PROVIDER_ID_X, CODES.providerId, /changes on \/clear/)
    })

    it('a released lease', async () => {
      h.records.set(SESSION_X, sessionRecord(SESSION_X, { lease: { claimStatus: 'released' } }))
      await expectRefusedWithNoEffects(SESSION_X, CODES.notLive, /is not running right now/)
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

    it('a lease the host has not reconciled since restart', async () => {
      h.records.set(SESSION_X, sessionRecord(SESSION_X, { lease: { unreconciled: true } }))
      await expectRefusedWithNoEffects(SESSION_X, CODES.notLive, /no live owner/)
    })

    it('a session whose record says it runs on another host', async () => {
      h.records.set(
        SESSION_X,
        sessionRecord(SESSION_X, { location: { executionHostId: 'ssh:devbox' } })
      )
      await expectRefusedWithNoEffects(SESSION_X, CODES.hostBoundary, /runs on another host/)
    })

    it('a request from an SSH or WSL environment', async () => {
      await expectRefusedWithNoEffects(SESSION_X, CODES.hostBoundary, /an SSH environment/, {
        host: { kind: 'ssh', targetId: 't', connectionIncarnation: 'c', attachmentId: 'a' }
      })
      await expectRefusedWithNoEffects(SESSION_X, CODES.hostBoundary, /a WSL environment/, {
        host: { kind: 'wsl', hostId: 'local', distro: 'Ubuntu' }
      })
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

    it('an agent-session host that cannot be brought up to verify it', async () => {
      hostRef.current = null
      await expectRefusedWithNoEffects(SESSION_X, CODES.notLive, /cannot be verified/)
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

    it("refuses a caller-supplied pane key on check, the restart fallback's substitute", async () => {
      const response = await h.dispatch(
        orchestrationRequest(
          'orchestration.check',
          { terminalPaneKey: 'tab_worker:77777777-7777-4777-8777-777777777777' },
          { sessionId: SESSION_X }
        )
      )
      expect(response).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
    })

    it.each([ADDRESS_X, SESSION_X])('accepts the session named as %s', async (declared) => {
      const run = resultOf(
        await h.dispatch(
          orchestrationRequest(
            'orchestration.runCreate',
            { objective: 'o', from: declared },
            { sessionId: SESSION_X }
          )
        )
      ).run
      expect(run).toMatchObject({ objective: 'o', coordinator_handle: null })
    })
  })

  it('leaves a terminal caller untouched: no claim, no normalization, no extra hop', async () => {
    const request = orchestrationRequest('orchestration.runCreate', {
      objective: 'o',
      from: 'term_worker'
    })
    expect(needsOrchestrationCallerResolution(request)).toBe(false)

    const run = resultOf(await h.dispatch(request)).run
    expect(run).toMatchObject({ coordinator_handle: 'term_worker' })
    expect(h.db.getRunRaw(idOf(run))?.coordinator_orca_session_id).toBeNull()
  })
})
