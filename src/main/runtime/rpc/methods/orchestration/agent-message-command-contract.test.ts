import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { UnixSocketTransport } from '../../unix-socket-transport'
import { sendRequest } from '../../../../../cli/runtime/transport'
import type { RuntimeMetadata } from '../../../../../shared/runtime-bootstrap'
import type { RuntimeOrchestrationEnvelope } from '../../../../../shared/runtime-rpc-envelope'
import { OrchestrationMutationExecutor } from '../../orchestration-mutation-executor'
import { CLIENT_HISTORY_READER } from '../../../../native-chat/agent-session-wire/agent-session-item-wire-form'
import { afterEach, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from './rpc-test-harness'
import { STATUS_METHODS } from '../status'
import { eraseRpcMethods } from '../../core'
import { partialRuntimeStore } from '../../../runtime-store-partial-fixture'
import { resolveOrchestrationSessionCaller } from '../../orchestration-session-caller'
import { setStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from '../../../../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import {
  hostTestAttachParams,
  hostTestOperationId
} from '../../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { testOrcaSessionId } from '../../../../../shared/orca-session-address-test-fixture'
import { agentMessageDisplayText } from '../../../../../shared/agent-session/agent-message-display-text'
import { readAgentMessageSource } from '../../../../../shared/agent-session/agent-session-message-source'
import { nativeChatMessageCopyText } from '../../../../../shared/native-chat-message-copy-text'
import {
  projectQueuedMessageCards,
  queuedMessageCardLine
} from '../../../../../shared/structured-agent-session-queued-cards'
import {
  projectStructuredAgentSessionStatusSummary,
  projectStructuredItemToNativeChat
} from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { latestStructuredAgentSessionPrompt } from '../../../../../shared/agent-session/requests/structured-agent-session-latest-request'
import { isOrcaDispatchPrompt } from '../../../../../shared/agent-row-primary-text'
import * as placement from './worker/worker-start-agent-placement'
import * as topology from './worker/worker-topology'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY
} from '../../../../../shared/protocol-version'
import {
  agentSessionMessagePayload,
  agentSessionSendBodyFingerprint
} from '../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import {
  agentMessageHeading,
  agentMessageSenderCanOpen
} from '../../../../../shared/agent-session/agent-message-presentation'
import { closeTestJournalHostDatabase } from '../../../../native-chat/agent-session-journal/journal-host-database-test-support'

const h = createOrchestrationRpcHarness()
let rig: QueuedMessageTestRig | undefined
let transport: UnixSocketTransport | undefined
const COORD = testOrcaSessionId('command-coordinator')
const WORKER = testOrcaSessionId('command-worker')
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await transport?.stop()
  transport = undefined
  await rig?.dispose()
  rig = undefined
  h.cleanup()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.doUnmock('../../../../../cli/runtime-client')
  vi.doUnmock('../../../../../cli/format')
  vi.resetModules()
  process.exitCode = 0
})

it.each([
  'worker-start',
  'saved-task',
  'dispatch',
  'configured-federated',
  'malformed-federated'
] as const)(
  'real %s argv constructs, persists and delivers canonical input with a derived task display',
  async (command) => {
    const federated = command.endsWith('federated')
    rig = await createQueuedMessageTestRig({ sessionId: WORKER })
    const current = rig
    setStructuredAgentSessionHost(current.host)
    const attach = hostTestAttachParams(null, {
      provider: 'claude',
      agent: 'claude',
      providerHandle: { kind: 'claude', sessionId: 'coordinator-thread', leafUuid: null },
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/private-fixture/claude' },
      envelope: {
        sessionId: COORD,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: null,
        payloadFingerprint: ''
      }
    })
    expect(await current.host.attach(QUEUED_RIG_CALLER, attach)).toMatchObject({ ok: true })
    let { db, runtime } = h.setup(
      false,
      partialRuntimeStore({ getSettings: () => ({ agentDefaultSurface: 'terminal' }) }),
      join(current.root, 'home-orchestration.db')
    )
    if (federated) {
      vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
        environmentId: 'remote',
        name: 'remote',
        peerFingerprint: 'peer',
        pairingRevision: 1
      })
      vi.spyOn(runtime, 'ensureOrchestrationFederationRelay').mockImplementation((runId) => {
        if (command === 'configured-federated') {
          const currentDb = runtime.getOrchestrationDb()
          const [dispatch] = currentDb.listActiveFederatedDispatches(runId)
          expect(
            JSON.parse(currentDb.getWorkerDispatch(dispatch.dispatch_id)!.start_options).launch
              .effective.agent
          ).toBe('codex')
        }
      })
      vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockImplementation(
        async (_host, method, params) => {
          if (method === 'status.get') {
            return {
              capabilities: [
                ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
                ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
                ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY
              ]
            }
          }
          if (
            !params ||
            typeof params !== 'object' ||
            !('dispatchId' in params) ||
            typeof params.dispatchId !== 'string'
          ) {
            throw new Error('missing remote dispatch')
          }
          const dispatchId = params.dispatchId
          if (method === 'orchestration.federationAttachStart') {
            if (command === 'configured-federated') {
              expect(params).toMatchObject({
                agent: 'codex-fugu',
                model: 'home-model',
                effort: 'high'
              })
            }
            return {
              dispatchId,
              state: 'ready',
              runtimeEpoch: 'remote-epoch',
              worktreeId: 'remote-workspace',
              terminalHandle: 'term_remote',
              ...(command === 'malformed-federated'
                ? { launch: {} }
                : command === 'configured-federated'
                  ? {
                      launch: {
                        requested: { agent: 'codex', model: 'peer-request', effort: 'low' },
                        effective: { agent: 'codex', model: 'effective-model', effort: 'medium' }
                      }
                    }
                  : {})
            }
          }
          if (method === 'orchestration.federationShow') {
            return {
              runtimeEpoch: 'remote-epoch',
              attachment: {
                state: 'succeeded',
                stage: 'worker_report_queued',
                last_error: null,
                worktree_id: 'remote-workspace',
                terminal_handle: 'term_remote',
                setup_state: 'not_applicable',
                effects: [],
                residualResources: []
              },
              terminal: null,
              observation: { status: 'exited', exactWorker: true }
            }
          }
          if (method === 'orchestration.federationPull') {
            const dispatch = db.getDispatchContextById(dispatchId)!
            return {
              runtimeEpoch: 'remote-epoch',
              items: ['status', 'worker_done'].map((type, index) => ({
                dispatch_id: dispatchId,
                direction: 'to_home',
                sequence: index + 1,
                message_id: `remote-${type}`,
                kind: type,
                payload: JSON.stringify({
                  from: 'term_remote',
                  subject: type,
                  body: 'Remote result',
                  type,
                  ...(type === 'worker_done'
                    ? {
                        payload: JSON.stringify({
                          dispatchId,
                          taskId: dispatch.task_id,
                          outcome: 'succeeded'
                        })
                      }
                    : {})
                })
              }))
            }
          }
          if (method === 'orchestration.federationAck') {
            return { acknowledgedThrough: 2 }
          }
          throw new Error(`unexpected remote method ${method}`)
        }
      )
    }
    vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue()
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    type WorkspaceLookup = {
      showManagedTerminalWorkspace: (
        ...args: Parameters<typeof runtime.showManagedTerminalWorkspace>
      ) => Promise<Awaited<ReturnType<typeof placement.placeWorkerAgent>>['worktree']>
    }
    vi.spyOn<WorkspaceLookup, 'showManagedTerminalWorkspace'>(
      runtime,
      'showManagedTerminalWorkspace'
    ).mockResolvedValue({
      id: 'workspace-1',
      repoId: 'repo'
    })
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
      runtimeId: runtime.getRuntimeId(),
      terminalHandle: 'term_worker',
      ptyId: 'pty',
      worktreeId: 'workspace-1',
      paneKey: 'tab:11111111-1111-4111-8111-111111111111',
      processIncarnation: 'fixture:1',
      launchTokenHash: null,
      hostScope: { kind: 'local', hostId: 'local' }
    })
    // Placement/provider are external fixtures; admission, constructors, host, journal, queue and settlement run in production.
    vi.spyOn(placement, 'placeWorkerAgent').mockImplementation(async (args) => ({
      mode: args.mode,
      worktree: { id: 'workspace-1', repoId: 'repo' },
      terminalHandle: 'term_worker',
      structuredSession: {
        host: current.host,
        identity: {
          sessionId: WORKER,
          handle: 'term_worker',
          agent: args.agent ?? null,
          paneKey: 'tab:11111111-1111-4111-8111-111111111111',
          processIncarnation: 'fixture:1',
          worktreeId: 'workspace-1',
          hostScope: { kind: 'local', hostId: 'local' }
        },
        fence: current.store.requireWritableRecord(WORKER).lease.runtimeFence
      },
      setupReceipt: placement.EXISTING_WORKTREE_SETUP
    }))
    vi.spyOn(topology, 'monitorWorkerSetup').mockImplementation(() => {})
    const run = db.createRun({
      objective: 'cards',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: COORD
    })
    vi.stubEnv('ORCA_AGENT_SESSION_ID', COORD)
    vi.stubEnv('ORCA_TERMINAL_HANDLE', '')
    vi.stubEnv('ORCA_PAIRING_CODE', '')
    vi.stubEnv('ORCA_ENVIRONMENT', '')
    const requests: string[] = []
    const requestBytes: number[] = []
    let rejectedFrames = 0
    const kind = process.platform === 'win32' ? 'named-pipe' : 'unix'
    const endpoint =
      kind === 'named-pipe'
        ? `\\\\.\\pipe\\orca-start-${randomUUID()}`
        : join(tmpdir(), `orca-start-${randomUUID()}.sock`)
    transport = new UnixSocketTransport({ kind, endpoint })
    const executor = new OrchestrationMutationExecutor(runtime)
    const requestSchema = z.object({
      id: z.string(),
      authToken: z.string(),
      method: z.string(),
      params: z.unknown().optional(),
      orchestrationRequestId: z.string().optional()
    })
    transport.onMessage((wire, reply) => {
      if (!wire) {
        rejectedFrames++
        reply(
          JSON.stringify({
            id: 'unknown',
            ok: false,
            error: { code: 'bad_request', message: 'Oversized request' }
          })
        )
        return
      }
      void (async () => {
        const request = requestSchema.parse(JSON.parse(wire))
        requestBytes.push(Buffer.byteLength(wire))
        const admitted = await resolveOrchestrationSessionCaller(
          runtime,
          {
            ...request,
            orchestrationCompatibilityEvidence: { agentSessionId: COORD }
          },
          undefined
        )
        requests.push(request.method)
        const rpc =
          request.method === 'status.get'
            ? eraseRpcMethods(STATUS_METHODS)[0]
            : h.findMethod(request.method)
        const parsed = rpc.params?.parse(admitted.request.params)
        const result = await executor.run(
          admitted.request,
          parsed,
          (mutation) =>
            rpc.handler(parsed, {
              runtime,
              orchestrationMutation: mutation?.identity,
              recordMutationReceipt: mutation?.recordReceipt,
              replayedMutationReceipt: mutation?.replayedReceipt,
              markMutationEffectPossible: mutation?.markEffectPossible,
              orchestrationCaller: admitted.caller,
              orchestrationCompatibilityEvidence:
                admitted.request.orchestrationCompatibilityEvidence
            }),
          undefined,
          admitted.caller?.sessionId
        )
        reply(
          JSON.stringify({
            id: request.id,
            ok: true,
            result,
            _meta: { runtimeId: runtime.getRuntimeId() }
          })
        )
      })().catch((error: unknown) => {
        const request = requestSchema.parse(JSON.parse(wire))
        reply(
          JSON.stringify({
            id: request.id,
            ok: false,
            error: {
              code: 'fixture_failure',
              message: String(error)
            }
          })
        )
      })
    })
    await transport.start()
    const metadata: RuntimeMetadata = {
      runtimeId: runtime.getRuntimeId(),
      pid: process.pid,
      startedAt: 1,
      authToken: 'test-token',
      transports: [{ kind, endpoint }]
    }
    const call = async (
      method: string,
      params: unknown,
      options?: RuntimeOrchestrationEnvelope
    ) => {
      const response = await sendRequest<unknown>(metadata, method, params, 10000, options)
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      return response
    }
    vi.doMock('../../../../../cli/runtime-client', async (original) => ({
      ...(await original<Record<string, unknown>>()),
      RuntimeClient: function () {
        return { isRemote: false, call }
      }
    }))
    const output =
      vi.fn<
        (response: {
          id: string
          ok: boolean
          result: Record<string, unknown>
          _meta: { runtimeId: string }
        }) => void
      >()
    vi.doMock('../../../../../cli/format', () => ({ printResult: output }))
    const cliPath = '../../../../../cli/index'
    const { main }: { main(argv: string[]): Promise<void> } = await import(cliPath)
    const task = `  Current task 🐋\r\n"\t\u0001\n=== TASK ===\nDo not clip the task.  ${command === 'dispatch' ? '' : '\n'.repeat(490000)}`
    let argv: string[]
    let openingSend: string | undefined
    if (command === 'dispatch') {
      openingSend = await current.workingSend()
      const created = db.createTask({ runId: run.id, spec: task })
      argv = [
        'orchestration',
        'dispatch',
        '--task',
        created.id,
        '--to',
        `orca_session_id:${WORKER}`,
        '--inject',
        '--return-preamble',
        '--json',
        '--full'
      ]
    } else {
      argv = [
        'orchestration',
        'worker-start',
        '--spec',
        task,
        '--agent',
        command === 'configured-federated' ? 'codex-fugu' : 'codex',
        ...(federated ? ['--on', 'remote', '--worktree', 'id:remote-workspace'] : []),
        ...(command === 'configured-federated'
          ? ['--model', 'home-model', '--effort', 'high']
          : []),
        '--timeout-ms',
        '1000',
        '--retry-request',
        '11111111-1111-4111-8111-111111111111',
        '--json',
        '--full'
      ]
    }
    if (command === 'saved-task') {
      await main(['orchestration', 'task-create', '--spec', task, '--json', '--full'])
      const created = db.listTasks({ runId: run.id }).find((entry) => entry.spec === task)
      if (!created) {
        throw new Error('serialized task-create did not store exact task')
      }
      argv.splice(argv.indexOf('--spec'), 2, '--task', created.id)
    }
    const running = main(argv)
    if (command !== 'dispatch' && !federated) {
      await eventually(() => expect(current.dispatch).toHaveBeenCalled())
      const id = current.dispatch.mock.calls[0][0].clientMessageId
      await current.settleAccepted(id, 'task-turn')
    }
    await running
    expect(requests).toContain(
      command === 'dispatch' ? 'orchestration.dispatch' : 'orchestration.workerStart'
    )
    if (command !== 'dispatch') {
      await eventually(async () =>
        expect(
          (await current.host.journalSnapshot(COORD)).items.filter(
            (item) => item.body.kind === 'agent-start'
          )
        ).toHaveLength(1)
      )
      const fact = (await current.host.journalSnapshot(COORD)).items.find(
        (item) => item.body.kind === 'agent-start'
      )
      if (!fact) {
        throw new Error('ready caller fact missing')
      }
      expect(fact.body).toMatchObject({ task, worker: { agent: 'codex' } })
      if (command === 'malformed-federated') {
        expect(output.mock.lastCall?.[0]).toMatchObject({ ok: true, result: { state: 'ready' } })
        return
      }
      const callerHistory = await current.host.history({ sessionId: COORD, direction: 'tail' })
      expect(callerHistory).toMatchObject({ ok: true, page: { items: [fact] } })
      const formed = CLIENT_HISTORY_READER.form(fact)
      expect(formed.item).toBe(fact)
      expect(formed.item.shortened).toBeUndefined()
      expect(formed.bytes).toBeGreaterThan(980000)
      expect(formed.bytes).toBeLessThan(CLIENT_HISTORY_READER.budgetBytes)
      expect(Math.max(...requestBytes)).toBeGreaterThan(980000)
      expect(Math.max(...requestBytes)).toBeLessThan(1024 * 1024)
      console.info('start input/reader bytes', {
        command,
        request: Math.max(...requestBytes),
        storedTask: Buffer.byteLength(task),
        row: formed.bytes,
        readerBudget: CLIENT_HISTORY_READER.budgetBytes
      })
      const placed = vi.mocked(placement.placeWorkerAgent).mock.calls.length
      const printed = output.mock.calls.length
      const resultBeforeReplay = output.mock.lastCall?.[0]
      if (!resultBeforeReplay) {
        throw new Error('successful worker-start response missing')
      }
      expect(resultBeforeReplay).toMatchObject({
        ok: true,
        _meta: { runtimeId: runtime.getRuntimeId() },
        result: { mutation: { requestId: '11111111-1111-4111-8111-111111111111', replayed: false } }
      })
      await main(argv)
      expect(process.exitCode ?? 0).toBe(0)
      expect(output).toHaveBeenCalledTimes(printed + 1)
      expect(output.mock.lastCall?.[0]).toEqual({
        ...resultBeforeReplay,
        id: expect.any(String),
        result: {
          ...resultBeforeReplay.result,
          mutation: { requestId: '11111111-1111-4111-8111-111111111111', replayed: true }
        }
      })
      expect(output.mock.lastCall?.[0].id).not.toBe(resultBeforeReplay.id)
      expect(placement.placeWorkerAgent).toHaveBeenCalledTimes(placed)
      expect(
        (await current.host.journalSnapshot(COORD)).items.filter(
          (item) => item.body.kind === 'agent-start'
        )
      ).toEqual([fact])
      const beforeWrites = db.listTasks({ runId: run.id }).length
      const beforeRequests = requests.length
      await expect(
        call('orchestration.taskCreate', { spec: task + '\n'.repeat(100000), run: run.id })
      ).rejects.toThrow()
      expect(rejectedFrames).toBe(1)
      expect(requests).toHaveLength(beforeRequests)
      expect(db.listTasks({ runId: run.id })).toHaveLength(beforeWrites)
    }
    if (command === 'configured-federated') {
      const dispatch = db.getDispatchContextById(
        z.string().parse(output.mock.lastCall?.[0].result.dispatchId)
      )!
      // New mail after reopening the actual home domain DB must retain the acquired alias kind.
      db = h.reopenDatabase()
      expect(JSON.parse(db.getWorkerDispatch(dispatch.id)!.start_options)).toMatchObject({
        agent: 'codex-fugu',
        launch: {
          requested: { agent: 'codex', model: 'home-model', effort: 'high' },
          effective: { agent: 'codex', model: 'effective-model', effort: 'medium' }
        }
      })
      await main(['orchestration', 'worker-show', '--dispatch', dispatch.id, '--json', '--full'])
      expect(requests).toContain('orchestration.workerShow')
      await eventually(async () => {
        const items = (await current.host.journalSnapshot(COORD)).items
        const mail = items.flatMap(({ body }) =>
          body.kind === 'message' ? (readAgentMessageSource(body.from)?.senders ?? []) : []
        )
        const messages = items.flatMap(({ body }) => {
          const source = body.kind === 'message' ? readAgentMessageSource(body.from) : null
          return source?.orchestration?.message === 'mail-notice'
            ? source.orchestration.messages
            : []
        })
        expect(messages.map((message) => message.messageId)).toEqual(
          expect.arrayContaining(['remote-status', 'remote-worker_done'])
        )
        expect(
          mail
            .filter((sender) => sender.party.address === `dispatch:${dispatch.id}`)
            .every((sender) => sender.agent === 'codex')
        ).toBe(true)
        expect(mail).toContainEqual(
          expect.objectContaining({
            party: expect.objectContaining({ address: `dispatch:${dispatch.id}` }),
            agent: 'codex'
          })
        )
      })
      const saved = (await current.host.journalSnapshot(COORD)).items
      await current.quitRestartHostProcess()
      await closeTestJournalHostDatabase(current.root)
      current.crashRestartHostProcess()
      const reopened = (await current.host.journalSnapshot(COORD)).items
      expect(
        reopened.filter(
          ({ body }) => body.kind === 'agent-start' || (body.kind === 'message' && body.from)
        )
      ).toEqual(
        saved.filter(
          ({ body }) => body.kind === 'agent-start' || (body.kind === 'message' && body.from)
        )
      )
      return
    }
    const snapshot = await current.host.journalSnapshot(WORKER)
    const history = await current.host.history({ sessionId: WORKER, direction: 'tail' })
    if (!history.ok) {
      throw new Error('cannot reload real history')
    }
    const queued = history.page.queuedMessages?.[0]
    if (command === 'dispatch') {
      expect(queued, 'busy --inject must enter the queue').toBeDefined()
      if (!queued) {
        throw new Error('busy dispatch bypassed queue')
      }
    } else {
      expect(queued, 'worker-start sends immediately').toBeUndefined()
    }
    const body =
      queued?.body ??
      snapshot.items.find((item) => item.body.kind === 'message' && item.body.from)?.body
    if (!body || body.kind !== 'message') {
      throw new Error('production host did not persist task')
    }
    const from = readAgentMessageSource(JSON.parse(JSON.stringify(body.from)))
    if (command !== 'dispatch') {
      expect(db.listTasks({ runId: run.id }).filter((entry) => entry.spec === task)).toHaveLength(1)
    }
    expect(from?.senders[0].party.orcaSessionId).toBe(COORD)
    expect(from?.senders[0].relation).toBe('coordinator')
    expect(from?.senders[0].agent).toBe('claude')
    if (!from) {
      throw new Error('sender source missing')
    }
    expect(agentMessageDisplayText(body.blocks, from)).toBe(task)
    const raw = nativeChatMessageCopyText(body)
    expect(raw).toContain('You are working inside Orca')
    expect(raw.endsWith(task)).toBe(true)
    const items = [{ itemId: 'task', sequence: 1, revision: 1, observedAt: 1, body }]
    expect(latestStructuredAgentSessionPrompt(items)).toBe(raw)
    const prompt = projectStructuredAgentSessionStatusSummary(items).latestPrompt
    expect(isOrcaDispatchPrompt(prompt)).toBe(true)
    expect(prompt).toContain('Current task')
    if (from?.orchestration?.message !== 'task') {
      throw new Error('task identity missing')
    }
    expect(prompt).toContain(`Your task ID is: ${from.orchestration.taskId}`)
    if (queued) {
      expect(agentMessageHeading(from, { blocks: [] })).toBe('task')
      expect(agentMessageSenderCanOpen(from.senders[0], true)).toBe(true)
      expect(agentSessionMessagePayload(body)).not.toHaveProperty('from')
      expect(agentSessionSendBodyFingerprint(WORKER, body)).toBe(
        agentSessionSendBodyFingerprint(WORKER, agentSessionMessagePayload(body))
      )
      const projected = projectStructuredItemToNativeChat({
        itemId: 'task-projection',
        sequence: 1,
        revision: 1,
        observedAt: 1,
        body
      })
      expect(projected?.from?.senders[0].agent).toBe('claude')
      const attributionPath =
        '../../../../../../mobile/src/session/mobile-agent-message-attribution'
      const { agentMessageAttribution } = await import(attributionPath)
      expect(agentMessageAttribution('Message from', projected?.from)).toBe(
        'Message from Claude Chat'
      )
      const queuePath =
        '../../../../../../mobile/src/session/mobile-structured-queued-message-cards'
      const { mobileQueuedMessageCards } = await import(queuePath)
      const [mobileCard] = mobileQueuedMessageCards([queued], [])
      expect(mobileCard.attribution).toBe('From Claude Chat')
      expect(mobileCard.line).toBe(task)
      expect(mobileCard.from.senders[0].agent).toBe('claude')
      const [card] = projectQueuedMessageCards([queued], [], {})
      expect(card.from?.senders[0].agent).toBe('claude')
      expect(queuedMessageCardLine(card)).toBe(task)
      expect(card.text).toBe(raw) // Exactly what the editor opens.
      const journal = current.host.collaboratorsForTests().sessions.get(WORKER)!.journal
      const edited = `${raw.slice(0, raw.length - task.length)}Edited task`
      const fields = {
        messageId: queued.messageId,
        expectedBodyFingerprint: journal.queuedMessages.get(queued.messageId)!.fingerprint,
        text: edited
      }
      expect(
        await current.host.queuedMessageUpdate(QUEUED_RIG_CALLER, {
          envelope: current.envelope(
            fields,
            'agentSession.queuedMessageUpdate',
            hostTestOperationId()
          ),
          ...fields
        })
      ).toMatchObject({ ok: true })
      const page = await current.host.history({ sessionId: WORKER, direction: 'tail' })
      if (!page.ok) {
        throw new Error('cannot reopen queue')
      }
      const reopened = page.page.queuedMessages!.find((row) => row.messageId === queued.messageId)!
      expect(nativeChatMessageCopyText(reopened.body)).toBe(edited)
      expect(reopened.body).not.toHaveProperty('from')
      if (!openingSend) {
        throw new Error('busy dispatch has no opening send')
      }
      expect(await current.sendNow(queued.messageId)).toMatchObject({ ok: true })
      await current.settleAccepted(openingSend, 'opening-task-turn')
      await eventually(async () => {
        const handoff = await current.handoffId(queued.messageId)
        const delivered = current.dispatch.mock.calls.find(
          ([args]) => args.clientMessageId === handoff
        )
        expect(delivered).toBeDefined()
        expect(nativeChatMessageCopyText(delivered![0].body)).toBe(edited)
      })
    } else {
      expect(nativeChatMessageCopyText(current.dispatch.mock.calls[0][0].body)).toBe(raw)
      if (command === 'saved-task') {
        return
      }
      await main([
        'orchestration',
        'send',
        '--to',
        `orca_session_id:${WORKER}`,
        '--subject',
        'Follow-up',
        '--body',
        'Review result',
        '--json',
        '--full'
      ])
      expect(requests).toContain('orchestration.send')
      await eventually(async () => {
        const items = (await current.host.journalSnapshot(WORKER)).items
        const mail = items.filter(
          ({ body }) =>
            body.kind === 'message' &&
            readAgentMessageSource(body.from)?.orchestration?.message === 'mail-notice'
        )
        expect(mail).toHaveLength(1)
        expect(mail[0].body).toMatchObject({
          from: { senders: [expect.objectContaining({ agent: 'claude' })] }
        })
      })
      const saved = (await current.host.journalSnapshot(WORKER)).items.filter(
        ({ body }) => body.kind === 'message' && body.from
      )
      await current.quitRestartHostProcess()
      await closeTestJournalHostDatabase(current.root)
      current.crashRestartHostProcess()
      expect(
        (await current.host.journalSnapshot(WORKER)).items.filter(
          ({ body }) => body.kind === 'message' && body.from
        )
      ).toEqual(saved)
    }
  },
  30000
)
