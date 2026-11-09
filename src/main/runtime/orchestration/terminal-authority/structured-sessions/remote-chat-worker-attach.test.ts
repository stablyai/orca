// A coordinator on another computer starts a chat worker here; the worker reports home over the relay.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EVERY_AGENT_CHAT } from '../../../../../shared/native-chat/every-agent-chat.test-fixture'
import { isStructuredWorkerHandle } from '../../../../../shared/orchestration/workers/structured-worker-handle'
import * as sessionCreate from '../../../rpc/methods/structured-sessions/creation/structured-agent-session-create'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { chatWorkerTurnStopReporter } from '../../workers/turn-stops/chat-worker-turn-stops'
import { encodeFederatedControlMessage } from '../../federation/relay/federation-control-message'
import * as placement from '../../../rpc/methods/orchestration/worker/folder-worktree-placement'
import * as worktreeName from '../../../rpc/methods/orchestration/worker/worker-worktree-creation'
import { attachParams } from './structured-chat-coordinator-fake-codex-fixture'
import {
  WAIT,
  call,
  codex,
  db,
  dispatcher,
  host,
  request,
  runtime,
  settleTurn,
  turnText
} from './structured-chat-coordinator-mail-rig.test-fixture'
import { resolveStructuredWorkerIdentity } from './structured-worker-authority'
import { reconcileRequestedWorkerTerminalReleases } from '../release/worker-terminal-release-reconciliation'

const DISPATCH = 'ctx_remote_chat'
const HOME = 'home_peer'

beforeEach(() => {
  vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
  vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({ supported: true })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: placement reads only the workspace identity in this rig.
  vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
    id: 'workspace-1',
    repoId: 'repo'
  } as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: launch-mode selection reads only getSettings on this store double.
  vi.spyOn(runtime, 'requireStore').mockReturnValue({
    getSettings: () => ({
      nativeChatProviders: EVERY_AGENT_CHAT,
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {}
    })
  } as never)
  vi.spyOn(sessionCreate, 'createStructuredAgentSessionForWorktree').mockImplementation(
    async (args) => {
      const attached = await host.attach(args.caller, attachParams(args.envelope.sessionId))
      if (!attached.ok) {
        throw new Error('scripted worker attach refused')
      }
      return {
        ...attached,
        value: { ...attached.value, sessionId: args.envelope.sessionId, fence: attached.fence }
      }
    }
  )
  // The rig fakes PTY identity for its own terminals; a chat worker's comes from its minted identity.
  const identity = (handle: string) =>
    isStructuredWorkerHandle(handle) ? resolveStructuredWorkerIdentity(handle, db) : null
  vi.mocked(runtime.getTerminalPaneKey).mockImplementation(
    (handle) => identity(handle)?.paneKey ?? null
  )
  vi.mocked(runtime.getTerminalProcessIncarnation).mockImplementation(
    (handle) => identity(handle)?.processIncarnation ?? null
  )
})

async function federation(name: string, params: Record<string, unknown>): Promise<unknown> {
  const response = await dispatcher.dispatch(request(name, params), {
    authenticatedCallerFingerprint: HOME
  })
  if (!response.ok) {
    throw new Error(`${name} failed: ${JSON.stringify(response)}`)
  }
  return response.result
}

/** The worker started and took its task, as a coordinator on another computer starts it. */
async function startedChatWorker() {
  const started = federation('orchestration.federationAttachStart', {
    runId: 'run_home',
    dispatchId: DISPATCH,
    taskId: 'task_home',
    taskSpec: 'Check the docs and report.',
    protocolVersion: 5,
    worktree: 'id:workspace-1',
    agent: 'codex'
  })
  await vi.waitFor(() => expect(codex.connections.at(-1)?.turns).toHaveLength(1), WAIT)
  const handle = String(db.getRemoteDispatchAttachment(DISPATCH)?.terminal_handle)
  const identity = resolveStructuredWorkerIdentity(handle, db)!
  const worker = codex.connections.at(-1)!
  await settleTurn(identity.sessionId, 0)
  return { receipt: await started, handle, identity, worker }
}

const homeBound = () =>
  db.listPendingFederationRelay(DISPATCH, 'to_home').map((item) => JSON.parse(item.payload))

describe('a chat worker that a coordinator on another computer starts here', () => {
  it('starts as a chat when this host prefers chats, and takes its task as its first turn', async () => {
    const { receipt, handle, identity, worker } = await startedChatWorker()

    expect(receipt).toMatchObject({
      state: 'ready',
      terminalHandle: handle,
      mode: { mode: 'structured' }
    })
    expect(isStructuredWorkerHandle(handle)).toBe(true)
    expect(worker.turns[0]!.text).toContain('Check the docs and report.')
    expect(db.getRemoteDispatchAttachment(DISPATCH)).toMatchObject({
      state: 'ready',
      pane_key: identity.paneKey,
      process_incarnation: identity.processIncarnation
    })
  })

  it('sends its mail home on the relay', async () => {
    const { identity } = await startedChatWorker()

    await expect(
      call(
        'orchestration.send',
        { subject: 'Halfway', body: 'docs checked' },
        { sessionId: identity.sessionId }
      )
    ).resolves.toMatchObject({ relay: { destination: 'run_home', dispatchId: DISPATCH } })
    expect(homeBound()).toEqual([expect.objectContaining({ subject: 'Halfway', type: 'status' })])
  })

  it('tells home when its turn ends without a report', async () => {
    const { identity } = await startedChatWorker()
    const timers: (() => void)[] = []
    const report = chatWorkerTurnStopReporter(
      { getDb: () => db, isWaitingForMail: () => false, notify: vi.fn() },
      (run) => timers.push(run)
    )

    report(
      {
        type: 'completion',
        completion: {
          scope: {
            executionHostId: LOCAL_EXECUTION_HOST_ID,
            wslDistro: null,
            workspaceId: 'workspace-1',
            workspaceKind: 'git-worktree'
          },
          sessionId: identity.sessionId,
          turnId: 'turn-1',
          outcome: 'success',
          completedAt: 1
        }
      },
      () => ({ status: 'idle', lastAssistantMessage: 'Docs look fine.' })
    )
    for (const run of timers.splice(0)) {
      run()
    }

    expect(homeBound()).toEqual([
      expect.objectContaining({ subject: 'Worker stopped without reporting' })
    ])
  })

  it("takes its coordinator's mail as a new turn", async () => {
    const { worker } = await startedChatWorker()

    await federation('orchestration.federationImport', {
      dispatchId: DISPATCH,
      items: [
        {
          dispatch_id: DISPATCH,
          direction: 'to_worker',
          sequence: 1,
          message_id: 'relay_home_1',
          kind: 'control_message',
          payload: encodeFederatedControlMessage({
            from: 'term_coord',
            subject: 'Also the changelog',
            body: 'Update the changelog too.',
            type: 'status',
            priority: 'normal',
            threadId: null,
            payload: null
          })
        }
      ]
    })

    await vi.waitFor(() => expect(worker.turns).toHaveLength(2), WAIT)
    expect(turnText(worker.turns[1]!)).toContain('Also the changelog')
  })

  it('shows its state and transcript as a local chat worker does', async () => {
    await startedChatWorker()

    await expect(
      federation('orchestration.federationShow', { dispatchId: DISPATCH })
    ).resolves.toMatchObject({ observation: { status: 'live', exactWorker: true } })
    await expect(
      federation('orchestration.federationFleetSnapshot', { dispatchIds: [DISPATCH] })
    ).resolves.toMatchObject({
      items: [{ dispatchId: DISPATCH, observation: { status: 'live', exactWorker: true } }]
    })
    const read = await federation('orchestration.federationReadOutput', { dispatchId: DISPATCH })
    expect(read).toMatchObject({ output: { source: 'transcript' } })
    expect(JSON.stringify(read)).toContain('Your task ID is: task_home')
    await expect(
      federation('orchestration.federationRead', { dispatchId: DISPATCH })
    ).rejects.toThrow(/chat worker with no terminal/)
  })

  it('closes its chat when its coordinator stops it', async () => {
    const { identity } = await startedChatWorker()

    await expect(
      federation('orchestration.federationStop', { dispatchId: DISPATCH })
    ).resolves.toMatchObject({ state: 'stopped', processAction: 'closed_agent_terminal' })
    expect(host.hasSession(identity.sessionId)).toBe(false)
    await expect(
      federation('orchestration.federationShow', { dispatchId: DISPATCH })
    ).resolves.toMatchObject({ observation: { status: 'exited' } })
  })

  it('closes its chat when its coordinator releases it after its report', async () => {
    const { identity } = await startedChatWorker()
    // Its report settled at the Run home, as a confirmed worker_done leaves it.
    db.recordRemoteAttachmentStage({
      dispatchId: DISPATCH,
      state: 'succeeded',
      stage: 'worker_reported'
    })

    await expect(
      federation('orchestration.federationRelease', { dispatchId: DISPATCH })
    ).resolves.toMatchObject({ state: 'released' })
    expect(host.hasSession(identity.sessionId)).toBe(false)
    expect(db.getRemoteDispatchAttachment(DISPATCH)).toMatchObject({ stage: 'released' })
  })

  it('closes its chat when its automatic release comes due', async () => {
    const { identity } = await startedChatWorker()
    db.recordRemoteAttachmentStage({
      dispatchId: DISPATCH,
      state: 'succeeded',
      stage: 'worker_reported'
    })
    const settledAt = Date.UTC(2026, 0, 1)
    db.armWorkerTerminalAutoReleaseStatement(DISPATCH, settledAt)
    expect(db.claimDueWorkerTerminalAutoReleases(settledAt + 3_600_000)).toBe(1)

    await reconcileRequestedWorkerTerminalReleases(runtime)

    expect(host.hasSession(identity.sessionId)).toBe(false)
    expect(db.getRemoteDispatchAttachment(DISPATCH)).toMatchObject({ stage: 'released' })
  })

  it('in a new worktree, takes its task only after a wait-for-setup setup finishes', async () => {
    vi.spyOn(placement, 'assertOrchestrationWorktreeCreationSupported').mockResolvedValue()
    vi.spyOn(worktreeName, 'resolveWorkerWorktreeName').mockResolvedValue({ name: 'w2' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch reads only these receipt fields.
    vi.spyOn(runtime, 'createManagedWorktree').mockResolvedValue({
      worktree: { id: 'workspace-1', displayName: 'w2' },
      setupReceipt: {
        hookFound: true,
        startupPolicy: 'wait-for-setup',
        state: 'running',
        terminalHandle: 'term_setup'
      }
    } as never)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: effects read only handle and title.
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [{ handle: 'term_setup', title: 'Setup' }]
    } as never)
    const setupDone = Promise.withResolvers<{ exitCode: number }>()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gate reads only exitCode.
    vi.spyOn(runtime, 'waitForSetupTerminalCompletion').mockReturnValue(setupDone.promise as never)

    const started = federation('orchestration.federationAttachStart', {
      runId: 'run_home',
      dispatchId: DISPATCH,
      taskId: 'task_home',
      taskSpec: 'Check the docs and report.',
      protocolVersion: 5,
      worktree: 'new-top-level',
      repo: 'id:repo',
      agent: 'codex'
    })
    await vi.waitFor(
      () => expect(runtime.waitForSetupTerminalCompletion).toHaveBeenCalledWith('term_setup'),
      WAIT
    )
    expect(codex.connections.flatMap((connection) => connection.turns)).toHaveLength(0)

    setupDone.resolve({ exitCode: 0 })
    await vi.waitFor(() => expect(codex.connections.at(-1)?.turns).toHaveLength(1), WAIT)
    const handle = String(db.getRemoteDispatchAttachment(DISPATCH)?.terminal_handle)
    await settleTurn(resolveStructuredWorkerIdentity(handle, db)!.sessionId, 0)
    await expect(started).resolves.toMatchObject({ state: 'ready', mode: { mode: 'structured' } })
  })

  it('starts a terminal, as before, for a home too old to know a chat worker', async () => {
    const createTerminal = vi
      .spyOn(runtime, 'createTerminal')
      .mockRejectedValue(new Error('terminal launch reached'))

    await expect(
      federation('orchestration.federationAttachStart', {
        runId: 'run_home',
        dispatchId: DISPATCH,
        taskId: 'task_home',
        taskSpec: 'Check the docs and report.',
        protocolVersion: 4,
        worktree: 'id:workspace-1',
        agent: 'codex'
      })
    ).resolves.toMatchObject({ state: 'failed', lastError: 'terminal launch reached' })
    expect(createTerminal).toHaveBeenCalledWith(
      'id:workspace-1',
      expect.objectContaining({ startupAgent: 'codex' })
    )
    expect(sessionCreate.createStructuredAgentSessionForWorktree).not.toHaveBeenCalled()
  })
})
