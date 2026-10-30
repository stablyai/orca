import { afterEach, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from './rpc-test-harness'
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
import { projectStructuredAgentSessionStatusSummary } from '../../../../../shared/structured-agent-session-projection'
import { latestStructuredAgentSessionPrompt } from '../../../../../shared/structured-agent-session-latest-request'
import { isOrcaDispatchPrompt } from '../../../../../shared/agent-row-primary-text'
import * as placement from './worker/worker-start-agent-placement'
import * as topology from './worker/worker-topology'

const h = createOrchestrationRpcHarness()
let rig: QueuedMessageTestRig | undefined
const COORD = testOrcaSessionId('command-coordinator')
const WORKER = testOrcaSessionId('command-worker')
afterEach(async () => {
  setStructuredAgentSessionHost(null)
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

it.each(['worker-start', 'dispatch'] as const)(
  'real %s argv constructs, persists and delivers canonical input with a derived task display',
  async (command) => {
    rig = await createQueuedMessageTestRig({ sessionId: WORKER })
    const current = rig
    setStructuredAgentSessionHost(current.host)
    const attach = hostTestAttachParams(null, {
      envelope: {
        sessionId: COORD,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: null,
        payloadFingerprint: ''
      }
    })
    expect(await current.host.attach(QUEUED_RIG_CALLER, attach)).toMatchObject({ ok: true })
    const { db, runtime } = h.setup(false)
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
    vi.doMock('../../../../../cli/runtime-client', async (original) => ({
      ...(await original<Record<string, unknown>>()),
      RuntimeClient: function () {
        return {
          isRemote: false,
          async call(method: string, params: Record<string, unknown> = {}) {
            const admitted = await resolveOrchestrationSessionCaller(
              runtime,
              {
                id: 'cli',
                authToken: 'test-token',
                method,
                params,
                orchestrationCompatibilityEvidence: { agentSessionId: COORD }
              },
              undefined
            )
            requests.push(method)
            const rpc = h.findMethod(method)
            const parsed = rpc.params?.parse(admitted.request.params)
            return {
              result: await rpc.handler(parsed, {
                runtime,
                orchestrationCaller: admitted.caller,
                orchestrationCompatibilityEvidence:
                  admitted.request.orchestrationCompatibilityEvidence
              })
            }
          }
        }
      }
    }))
    const output = vi.fn()
    vi.doMock('../../../../../cli/format', () => ({ printResult: output }))
    const cliPath = '../../../../../cli/index'
    const { main }: { main(argv: string[]): Promise<void> } = await import(cliPath)
    const task = '  Current task 🐋\r\n\r\n=== TASK ===\nDo not clip the task.  '
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
        '--json'
      ]
    } else {
      argv = [
        'orchestration',
        'worker-start',
        '--spec',
        task,
        '--agent',
        'codex',
        '--timeout-ms',
        '1000',
        '--json'
      ]
    }
    const running = main(argv)
    if (command === 'worker-start') {
      await eventually(() => expect(current.dispatch).toHaveBeenCalled())
      const id = current.dispatch.mock.calls[0][0].clientMessageId
      await current.settleAccepted(id, 'task-turn')
    }
    await running
    expect(requests).toContain(
      command === 'dispatch' ? 'orchestration.dispatch' : 'orchestration.workerStart'
    )
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
    expect(from?.senders[0].party.orcaSessionId).toBe(COORD)
    expect(from?.senders[0].relation).toBe('coordinator')
    expect(agentMessageDisplayText(body.blocks, from)).toBe(task)
    const raw = nativeChatMessageCopyText(body)
    expect(raw).toContain('You are working inside Orca')
    expect(raw.endsWith(task)).toBe(true)
    const items = [{ itemId: 'task', sequence: 1, revision: 1, observedAt: 1, body }]
    expect(latestStructuredAgentSessionPrompt(items)).toBe(raw)
    const prompt = projectStructuredAgentSessionStatusSummary(items).latestPrompt
    expect(isOrcaDispatchPrompt(prompt)).toBe(true)
    expect(prompt).toContain('=== TASK === Current task')
    if (from?.orchestration?.message !== 'task') {
      throw new Error('task identity missing')
    }
    expect(prompt).toContain(`Your task ID is: ${from.orchestration.taskId}`)
    if (queued) {
      const [card] = projectQueuedMessageCards([queued], [], {})
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
    }
  }
)
