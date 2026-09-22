import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { eraseRpcMethods, type RpcContext, type RpcRequest } from '../../../core'
import { OrchestrationDb } from '../../../../orchestration/db'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationMutationExecutor } from '../../../orchestration-mutation-executor'
import { hashCanonical } from '../../../orchestration-mutation-receipt'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import type {
  RuntimeTerminalPromptDelivery,
  RuntimeTerminalShow
} from '../../../../../../shared/runtime-terminal-contracts'
import type { PtyLivenessVerdict } from '../../../../../../shared/pty-liveness-verdict'

const COORD_PANE = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKER_PANE = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const INCARNATION = 'runtime_test:pty-worker:1'

type ResumeReceipt = {
  dispatchId: string
  state: string
  resumed: boolean
  route: string
  observation: string
  detail: string
  mutation?: { requestId: string; replayed: boolean }
}

function turnStarted(): RuntimeTerminalPromptDelivery {
  return {
    requestId: 'prompt-1',
    stages: ['input_accepted', 'turn_started'],
    provider: 'claude',
    observation: 'supported',
    processIncarnation: INCARNATION,
    generation: 1,
    baselineWorkingSequence: 0
  }
}

function acceptedOnly(): RuntimeTerminalPromptDelivery {
  return { ...turnStarted(), stages: ['input_accepted'] }
}

function terminalShow(handle: string): RuntimeTerminalShow {
  return {
    handle,
    ptyId: 'pty-worker',
    worktreeId: 'repo::worktree',
    worktreePath: '/repo/worktree',
    branch: 'main',
    tabId: 'tab-worker',
    leafId: 'leaf-worker',
    title: 'worker',
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: '',
    paneRuntimeId: 1,
    rendererGraphEpoch: 1,
    agentWait: null
  }
}

const LIVE: PtyLivenessVerdict = { status: 'live', ptyIds: ['pty-worker'] }
const EXITED: PtyLivenessVerdict = { status: 'exited' }
const UNVERIFIABLE: PtyLivenessVerdict = { status: 'unverifiable', reason: 'relay_dropped' }

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the RPC registry types every handler result as unknown; every assertion below reads only fields orchestration.workerResume is declared to return, and a shape drift fails those assertions.
const asResumeReceipt = (value: unknown): Promise<ResumeReceipt> => value as Promise<ResumeReceipt>

describe('orchestration.workerResume', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let executor: OrchestrationMutationExecutor
  let dispatchId: string
  let taskId: string
  let sendPrompt: ReturnType<typeof vi.spyOn>
  let agentStatus: ReturnType<typeof vi.spyOn>
  let livenessVerdict: ReturnType<typeof vi.spyOn>
  let showTerminal: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'resume test',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORD_PANE
    })
    taskId = db.createTask({ spec: 'idle worker', runId: run.id }).id
    dispatchId = createRootDispatch(
      db,
      taskId,
      'term_worker',
      WORKER_PANE,
      undefined,
      INCARNATION
    ).id
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_worker' ? WORKER_PANE : handle === 'term_coord' ? COORD_PANE : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? INCARNATION : null
    )
    showTerminal = vi
      .spyOn(runtime, 'showTerminal')
      .mockImplementation(async (handle) => terminalShow(handle))
    livenessVerdict = vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue(LIVE)
    agentStatus = vi
      .spyOn(runtime, 'getTerminalAgentStatus')
      .mockResolvedValue({ handle: 'term_worker', isRunningAgent: true, status: 'idle' })
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    sendPrompt = vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1,
      prompt: turnStarted()
    })
    ctx = { runtime }
    executor = new OrchestrationMutationExecutor(runtime)
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  function method() {
    const found = eraseRpcMethods(ORCHESTRATION_METHODS).find(
      (candidate) => candidate.name === 'orchestration.workerResume'
    )
    if (!found) {
      throw new Error('orchestration.workerResume is not registered')
    }
    return found
  }

  function resume(params: Record<string, unknown> = {}): Promise<ResumeReceipt> {
    const found = method()
    return asResumeReceipt(
      found.handler(found.params!.parse({ dispatch: dispatchId, ...params }), ctx)
    )
  }

  /** The same call a client repeats when it never saw the first response. */
  function resumeWithRequestId(
    requestId: string,
    extra: Record<string, unknown> = {}
  ): Promise<ResumeReceipt> {
    const params = { dispatch: dispatchId, ...extra }
    const request: RpcRequest = {
      id: `rpc-${requestId}`,
      authToken: 'token',
      method: 'orchestration.workerResume',
      orchestrationRequestId: requestId,
      params
    }
    const found = method()
    return asResumeReceipt(
      executor.run(request, params, () => found.handler(found.params!.parse(params), ctx))
    )
  }

  /** The assignment resume acted on, as the two lookups a duplicate Dispatch would displace. */
  function assignmentIds(): (string | undefined)[] {
    return [
      db.getLatestDispatchForTerminal('term_worker')?.id,
      db.getActiveDispatchForIdentity('term_worker', WORKER_PANE)?.id
    ]
  }

  it('resumes an idle assigned worker through the supported prompt route', async () => {
    const statusBefore = db.getTask(taskId)?.status

    const receipt = await resume()

    expect(receipt.state).toBe('resumed')
    expect(receipt.resumed).toBe(true)
    expect(receipt.route).toBe('terminal')
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    expect(sendPrompt.mock.calls[0]?.[1]).toContain(
      `orca orchestration check --terminal term_worker --dispatch ${dispatchId} --json`
    )
    // No duplicate dispatch: resume acts on the assignment that already exists.
    expect(assignmentIds()).toEqual([dispatchId, dispatchId])
    expect(db.getTask(taskId)?.status).toBe(statusBefore)
  })

  it('shows exactly one prompt execution when the same resume is retried', async () => {
    const first = await resumeWithRequestId('resume-retry-1')
    const retry = await resumeWithRequestId('resume-retry-1')

    expect(sendPrompt).toHaveBeenCalledTimes(1)
    expect(first.state).toBe('resumed')
    expect(retry.state).toBe('resumed')
    expect(retry.mutation?.replayed).toBe(true)
    expect(assignmentIds()).toEqual([dispatchId, dispatchId])
  })

  it('refuses to resend after a crash between the write and the recorded receipt', async () => {
    // What a restart leaves behind: a pending receipt whose outcome nobody recorded, and no
    // in-process attempt to join. The prompt may already have reached the worker, so the retry
    // must not write a second one — it must say it does not know.
    const params = { dispatch: dispatchId }
    db.beginMutationReceipt({
      callerFingerprint: db.getOrCreateLocalMutationCallerFingerprint(),
      requestId: 'resume-crashed-1',
      method: 'orchestration.workerResume',
      payloadHash: hashCanonical({ method: 'orchestration.workerResume', params })
    })

    await expect(resumeWithRequestId('resume-crashed-1')).rejects.toMatchObject({
      code: 'operation_unknown'
    })
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(assignmentIds()).toEqual([dispatchId, dispatchId])
  })

  it('joins a duplicate concurrent request with the same id instead of prompting twice', async () => {
    let releasePrompt = (): void => undefined
    const held = new Promise<void>((resolve) => {
      releasePrompt = () => resolve()
    })
    sendPrompt.mockImplementation(async () => {
      await held
      return { handle: 'term_worker', accepted: true, bytesWritten: 1, prompt: turnStarted() }
    })

    const first = resumeWithRequestId('resume-concurrent-1')
    const duplicate = resumeWithRequestId('resume-concurrent-1')
    releasePrompt()
    const [firstReceipt, duplicateReceipt] = await Promise.all([first, duplicate])

    expect(sendPrompt).toHaveBeenCalledTimes(1)
    expect(firstReceipt.state).toBe('resumed')
    expect(duplicateReceipt.state).toBe('resumed')
    expect(duplicateReceipt.mutation?.replayed).toBe(true)
  })

  it('refuses the same request id carrying a changed note rather than treating it as a retry', async () => {
    await resumeWithRequestId('resume-mismatch-1')

    await expect(
      resumeWithRequestId('resume-mismatch-1', { note: 'rebase first' })
    ).rejects.toMatchObject({ code: 'request_mismatch' })
    expect(sendPrompt).toHaveBeenCalledTimes(1)
  })

  it('reports an active turn without sending a second prompt into it', async () => {
    agentStatus.mockResolvedValue({
      handle: 'term_worker',
      isRunningAgent: true,
      status: 'working'
    })

    const receipt = await resume()

    expect(receipt.state).toBe('active_turn')
    expect(receipt.resumed).toBe(false)
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('reports a denied action and writes nothing when the agent is behind a guard', async () => {
    agentStatus.mockResolvedValue({
      handle: 'term_worker',
      isRunningAgent: true,
      status: 'permission'
    })

    const receipt = await resume()

    expect(receipt.state).toBe('denied_action')
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('reports a denied action when the write route itself refuses past a guard', async () => {
    sendPrompt.mockRejectedValue(new Error('agent_prompt_blocked'))

    const receipt = await resume()

    expect(receipt.state).toBe('denied_action')
  })

  it('reports a missing acknowledgement rather than duplicating a batch the worker holds', async () => {
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatchId}`,
      subject: 'guidance already delivered',
      runId: db.getDispatchContextById(dispatchId)!.run_id
    })
    const dispatch = db.getDispatchContextById(dispatchId)!
    db.getOrCreateMailboxDelivery({
      runId: dispatch.run_id,
      mailboxHandle: `dispatch:${dispatchId}`,
      consumerGeneration: dispatch.consumer_generation,
      consumerSource: 'dispatch'
    })

    const receipt = await resume()

    expect(receipt.state).toBe('missing_acknowledgement')
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('reports an exited process as a verdict', async () => {
    livenessVerdict.mockReturnValue(EXITED)

    const receipt = await resume()

    expect(receipt.state).toBe('exited_process')
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('reports unknown liveness when contact is lost, never as death', async () => {
    livenessVerdict.mockReturnValue(UNVERIFIABLE)

    const receipt = await resume()

    expect(receipt.state).toBe('unknown_liveness')
    expect(receipt.detail).toContain('never proof')
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('reports a queued prompt when the agent took the input but started no turn', async () => {
    sendPrompt.mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1,
      prompt: acceptedOnly()
    })
    vi.spyOn(runtime, 'observeTerminalAgentPrompt').mockResolvedValue(acceptedOnly())

    const receipt = await resume()

    expect(receipt.state).toBe('queued_prompt')
    expect(receipt.resumed).toBe(false)
  })

  it('refuses a settled Attempt instead of resuming it', async () => {
    db.failDispatch(dispatchId, 'the attempt was abandoned')

    await expect(resume()).rejects.toMatchObject({ code: 'dispatch_inactive' })
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('names an unknown Dispatch as not found', async () => {
    await expect(resume({ dispatch: 'ctx_missing' })).rejects.toMatchObject({
      code: 'dispatch_not_found'
    })
  })

  it('reports the six non-resumed states distinctly across the same route', async () => {
    const states = new Set<string>()
    agentStatus.mockResolvedValue({
      handle: 'term_worker',
      isRunningAgent: true,
      status: 'working'
    })
    states.add((await resume()).state)
    agentStatus.mockResolvedValue({
      handle: 'term_worker',
      isRunningAgent: true,
      status: 'permission'
    })
    states.add((await resume()).state)
    agentStatus.mockResolvedValue({ handle: 'term_worker', isRunningAgent: true, status: 'idle' })
    showTerminal.mockImplementation(async (handle) => terminalShow(handle))
    livenessVerdict.mockReturnValue(EXITED)
    states.add((await resume()).state)
    livenessVerdict.mockReturnValue(UNVERIFIABLE)
    states.add((await resume()).state)
    livenessVerdict.mockReturnValue(LIVE)
    sendPrompt.mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1,
      prompt: acceptedOnly()
    })
    vi.spyOn(runtime, 'observeTerminalAgentPrompt').mockResolvedValue(acceptedOnly())
    states.add((await resume()).state)
    sendPrompt.mockResolvedValue({ handle: 'term_worker', accepted: true, bytesWritten: 1 })
    states.add((await resume()).state)

    expect([...states].sort()).toEqual([
      'active_turn',
      'denied_action',
      'exited_process',
      'missing_acknowledgement',
      'queued_prompt',
      'unknown_liveness'
    ])
  })
})
