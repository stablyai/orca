import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import { ORCHESTRATION_METHODS } from './orchestration'

const COORDINATOR_PANE_KEY = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function workerPaneKey(handle: string): string {
  const index = Number(handle.match(/(\d+)$/)?.[1] ?? 1)
  return `tab_${handle}:00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

function workerProcessIncarnation(handle: string): string {
  return `runtime_test:${handle}:1`
}

describe('orchestration worker disposition barrier', () => {
  let db: OrchestrationDb
  let dbOpen = false
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let activeRunId: string
  let createdWorkerCount = 0
  let workerCapabilities = new Map<string, string>()

  function setup(dbPath: string = ':memory:'): void {
    db = new OrchestrationDb(dbPath)
    dbOpen = true
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    createdWorkerCount = 0
    workerCapabilities = new Map()
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord'
        ? COORDINATOR_PANE_KEY
        : handle.startsWith('term_worker_')
          ? workerPaneKey(handle)
          : null
    )
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      runtime.getTerminalPaneKey(handle)
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle.startsWith('term_worker_') ? workerProcessIncarnation(handle) : null
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle.startsWith('term_worker_')
        ? ({
            terminalHandle: handle,
            paneKey: workerPaneKey(handle),
            processIncarnation: workerProcessIncarnation(handle),
            hostScope: { kind: 'local', hostId: 'local' }
          } as never)
        : null
    )
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showTerminal').mockImplementation(
      async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
    )
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::worktree'
    } as never)
    vi.spyOn(runtime, 'createTerminal').mockImplementation(async () => {
      createdWorkerCount += 1
      return {
        handle: `term_worker_${createdWorkerCount}`,
        worktreeId: 'repo::worktree',
        title: 'worker'
      }
    })
    vi.spyOn(runtime, 'waitForTerminal').mockImplementation(async (handle) => ({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    }))
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockImplementation(async (handle, prompt) => {
      const capability = prompt.match(/--dispatch-capability (\S+)/)?.[1]
      if (!capability) {
        throw new Error('Expected worker Dispatch capability in preamble')
      }
      workerCapabilities.set(handle, capability)
      return { handle, accepted: true, bytesWritten: 1 }
    })
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(runtime, 'getExactWorkerProviderSession').mockReturnValue(null)
    vi.spyOn(runtime, 'readTerminal').mockImplementation(async (handle) => ({
      handle,
      status: 'running',
      tail: [`output from ${handle}`],
      truncated: false,
      nextCursor: '1'
    }))
    vi.spyOn(runtime, 'closeTerminal').mockImplementation(
      async (handle) => ({ handle, tabId: `tab_${handle}`, ptyKilled: true }) as never
    )
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    activeRunId = db.createRun({
      objective: 'Disposition barrier test Run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORDINATOR_PANE_KEY
    }).id
    ctx = { runtime }
  }

  afterEach(() => {
    if (dbOpen) {
      dbOpen = false
      db.close()
    }
    vi.restoreAllMocks()
  })

  async function call(
    name: string,
    params: Record<string, unknown>,
    callContext: RpcContext = ctx
  ) {
    const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, callContext)
  }

  async function startWorker(options: { terminal?: string } = {}): Promise<{
    taskId: string
    dispatchId: string
    terminalHandle: string
  }> {
    const task = db.createTask({ spec: 'disposition fixture task', runId: activeRunId })
    const result = (await call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      ...(options.terminal ? { terminal: options.terminal } : { agent: 'codex' })
    })) as { dispatchId: string; state: string }
    expect(result.state).toBe('ready')
    const terminalHandle = db.getWorkerDispatch(result.dispatchId)?.agent_terminal_handle
    if (!terminalHandle) {
      throw new Error('Expected worker terminal')
    }
    return { taskId: task.id, dispatchId: result.dispatchId, terminalHandle }
  }

  async function reportWorkerDone(
    worker: { taskId: string; dispatchId: string; terminalHandle: string },
    outcome: 'succeeded' | 'failed' = 'succeeded'
  ): Promise<void> {
    const capability = workerCapabilities.get(worker.terminalHandle)
    if (!capability) {
      throw new Error(`Missing Dispatch capability for ${worker.terminalHandle}`)
    }
    await expect(
      call(
        'orchestration.send',
        {
          from: worker.terminalHandle,
          subject: 'Done',
          type: 'worker_done',
          senderPaneKey: workerPaneKey(worker.terminalHandle),
          payload: JSON.stringify({
            taskId: worker.taskId,
            dispatchId: worker.dispatchId,
            outcome,
            filesModified: []
          })
        },
        { ...ctx, orchestrationCapability: capability }
      )
    ).resolves.toMatchObject({
      lifecycle: { action: outcome === 'succeeded' ? 'completed' : 'failed' }
    })
  }

  function markWorkerFederated(worker: { dispatchId: string; terminalHandle: string }): void {
    db.db
      .prepare('DELETE FROM worker_terminal_resources WHERE owner_dispatch_id = ?')
      .run(worker.dispatchId)
    db.db
      .prepare(
        `INSERT INTO federated_dispatches (
           dispatch_id, environment_id, environment_name, peer_fingerprint,
           remote_runtime_epoch, remote_worktree_id, remote_terminal_handle
         ) VALUES (?, 'env_remote', 'remote', 'peer_remote', 'runtime_remote', ?, ?)`
      )
      .run(worker.dispatchId, 'repo::worktree', worker.terminalHandle)
  }

  async function readDelivery(): Promise<{ deliveryId: string; messages: { type: string }[] }> {
    return (await call('orchestration.check', {
      terminal: 'term_coord'
    })) as { deliveryId: string; messages: { type: string }[] }
  }

  it('keeps a batch outstanding until every completed worker is dispositioned', async () => {
    setup()
    const first = await startWorker()
    const second = await startWorker()
    await reportWorkerDone(first)
    await reportWorkerDone(second)
    const delivery = await readDelivery()

    expect(delivery.messages.map((message) => message.type)).toEqual(['worker_done', 'worker_done'])
    await expect(
      call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
    ).rejects.toMatchObject({
      code: 'worker_disposition_required',
      data: { runId: activeRunId, dispatchIds: [first.dispatchId, second.dispatchId] }
    })
    await expect(readDelivery()).resolves.toMatchObject({ deliveryId: delivery.deliveryId })

    await call('orchestration.workerRetain', { dispatch: first.dispatchId })
    await call('orchestration.workerRetain', { dispatch: second.dispatchId })
    await expect(
      call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
    ).resolves.toMatchObject({ acknowledged: delivery.deliveryId })
  })

  it('blocks acknowledgment when a worker completes after the Delivery snapshot', async () => {
    setup()
    db.insertMessage({
      from: 'worker',
      to: `run:${activeRunId}`,
      subject: 'Earlier status',
      runId: activeRunId
    })
    const earlier = await readDelivery()
    const worker = await startWorker()
    await reportWorkerDone(worker)

    await expect(
      call('orchestration.check', { terminal: 'term_coord', ack: earlier.deliveryId })
    ).rejects.toMatchObject({
      code: 'worker_disposition_required',
      data: { dispatchIds: [worker.dispatchId] }
    })
    await expect(
      call('orchestration.check', {
        terminal: 'term_coord',
        peek: true,
        types: 'worker_done'
      })
    ).resolves.toMatchObject({ messages: [{ type: 'worker_done' }] })
  })

  it('keeps failed worker report disposition durable across a Task retry', async () => {
    setup()
    const worker = await startWorker()
    await reportWorkerDone(worker, 'failed')
    const delivery = await readDelivery()
    db.createStartingWorkerDispatch({
      taskId: worker.taskId,
      retryOf: worker.dispatchId,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 1
    })

    await expect(
      call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
    ).rejects.toMatchObject({
      code: 'worker_disposition_required',
      data: { dispatchIds: [worker.dispatchId] }
    })
  })

  it('keeps an accepted failed report behind the barrier after worker abandon', async () => {
    setup()
    const worker = await startWorker()
    await reportWorkerDone(worker, 'failed')
    const delivery = await readDelivery()

    await expect(
      call('orchestration.workerAbandon', { dispatch: worker.dispatchId })
    ).resolves.toMatchObject({ state: 'abandoned' })
    await expect(
      call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
    ).rejects.toMatchObject({
      code: 'worker_disposition_required',
      data: { dispatchIds: [worker.dispatchId] }
    })
    await call('orchestration.workerRetain', { dispatch: worker.dispatchId })
    await expect(
      call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
    ).resolves.toMatchObject({ acknowledged: delivery.deliveryId })
  })

  it('rechecks disposition on duplicate acknowledgment', async () => {
    setup()
    db.insertMessage({
      from: 'worker',
      to: `run:${activeRunId}`,
      subject: 'Initial status',
      runId: activeRunId
    })
    const delivery = await readDelivery()
    await call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
    const worker = await startWorker()
    await reportWorkerDone(worker)

    await expect(
      call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
    ).rejects.toMatchObject({
      code: 'worker_disposition_required',
      data: { dispatchIds: [worker.dispatchId] }
    })
  })

  it('does not return from a filtered wait when a worker completes during the wait', async () => {
    setup()
    const worker = await startWorker()
    const waitForMessage = vi.spyOn(runtime, 'waitForMessage').mockImplementation(async () => {
      await reportWorkerDone(worker)
      return 'timed_out'
    })

    await expect(
      call('orchestration.check', {
        terminal: 'term_coord',
        wait: true,
        types: 'question',
        timeoutMs: 100
      })
    ).rejects.toMatchObject({
      code: 'worker_disposition_required',
      data: { dispatchIds: [worker.dispatchId] }
    })
    expect(waitForMessage).toHaveBeenCalledOnce()
  })

  it('wakes a filtered Run waiter as soon as a worker completes', async () => {
    setup()
    vi.mocked(runtime.notifyMessageArrived).mockRestore()
    const worker = await startWorker()
    const waitForMessage = vi.spyOn(runtime, 'waitForMessage')
    const controller = new AbortController()
    const waiting = call(
      'orchestration.check',
      {
        terminal: 'term_coord',
        wait: true,
        types: 'question',
        timeoutMs: 60_000
      },
      { ...ctx, signal: controller.signal }
    ).catch((error: unknown) => error)
    await vi.waitFor(() => expect(waitForMessage).toHaveBeenCalledOnce())

    await reportWorkerDone(worker)
    const timeout = Symbol('still_waiting')
    let outcome: unknown
    try {
      outcome = await Promise.race([
        waiting,
        new Promise((resolve) => setTimeout(() => resolve(timeout), 250))
      ])
    } finally {
      controller.abort()
      await waiting
    }

    expect(outcome).not.toBe(timeout)
    expect(outcome).toMatchObject({
      code: 'worker_disposition_required',
      data: { dispatchIds: [worker.dispatchId] }
    })
  })

  it('does not return matching peek rows while a filtered worker completion is hidden', async () => {
    setup()
    const worker = await startWorker()
    await reportWorkerDone(worker)
    db.insertMessage({
      from: 'term_worker_question',
      to: `run:${activeRunId}`,
      subject: 'Question',
      type: 'question',
      runId: activeRunId
    })
    const waitForMessage = vi.spyOn(runtime, 'waitForMessage').mockResolvedValue('timed_out')

    await expect(
      call('orchestration.check', {
        terminal: 'term_coord',
        peek: true,
        wait: true,
        types: 'question',
        timeoutMs: 100
      })
    ).rejects.toMatchObject({
      code: 'worker_disposition_required',
      data: { dispatchIds: [worker.dispatchId] }
    })
    expect(waitForMessage).not.toHaveBeenCalled()
  })

  it('reports an applied acknowledgment when a completion interrupts the following wait', async () => {
    setup()
    db.insertMessage({
      from: 'worker',
      to: `run:${activeRunId}`,
      subject: 'Earlier status',
      runId: activeRunId
    })
    const delivery = await readDelivery()
    const worker = await startWorker()
    vi.spyOn(runtime, 'waitForMessage').mockImplementation(async () => {
      await reportWorkerDone(worker)
      return 'timed_out'
    })

    await expect(
      call('orchestration.check', {
        terminal: 'term_coord',
        ack: delivery.deliveryId,
        wait: true,
        types: 'question',
        timeoutMs: 100
      })
    ).rejects.toMatchObject({
      code: 'worker_disposition_required',
      data: {
        effectsApplied: true,
        acknowledged: delivery.deliveryId,
        dispatchIds: [worker.dispatchId]
      }
    })
    await expect(readDelivery()).resolves.toMatchObject({
      messages: [{ type: 'worker_done' }]
    })
  })

  it('blocks acknowledgment while an asynchronous release is still provisional', async () => {
    setup()
    const worker = await startWorker()
    await reportWorkerDone(worker)
    const delivery = await readDelivery()
    let finishInspection: (() => void) | undefined
    vi.mocked(runtime.showTerminal).mockImplementationOnce(
      (handle) =>
        new Promise((resolve) => {
          finishInspection = () =>
            resolve({ handle, worktreeId: 'repo::worktree', status: 'running' } as never)
        })
    )

    const release = call('orchestration.workerRelease', { dispatch: worker.dispatchId })
    await vi.waitFor(() => {
      expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)?.release_state).toBe(
        'requested'
      )
    })
    await expect(
      call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
    ).rejects.toMatchObject({
      code: 'worker_disposition_required',
      data: { dispatchIds: [worker.dispatchId] }
    })

    finishInspection?.()
    await expect(release).resolves.toMatchObject({ state: 'released' })
    await expect(
      call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
    ).resolves.toMatchObject({ acknowledged: delivery.deliveryId })
  })

  it('allows acknowledgment after public worker release', async () => {
    setup()
    const worker = await startWorker()
    await reportWorkerDone(worker)
    const delivery = await readDelivery()

    await expect(
      call('orchestration.workerRelease', { dispatch: worker.dispatchId })
    ).resolves.toMatchObject({ state: 'released' })
    await expect(
      call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
    ).resolves.toMatchObject({ acknowledged: delivery.deliveryId })
  })

  it('treats a reused external terminal as already retained without closing it', async () => {
    setup()
    const worker = await startWorker({ terminal: 'term_worker_external' })
    await reportWorkerDone(worker)
    const delivery = await readDelivery()

    await expect(
      call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
    ).resolves.toMatchObject({ acknowledged: delivery.deliveryId })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('keeps SSH identity ambiguity behind the barrier without closing the terminal', async () => {
    setup()
    const worker = await startWorker()
    await reportWorkerDone(worker)
    const delivery = await readDelivery()
    vi.mocked(runtime.getOrchestrationDispatchAuthority).mockReturnValue({
      terminalHandle: worker.terminalHandle,
      paneKey: workerPaneKey(worker.terminalHandle),
      processIncarnation: workerProcessIncarnation(worker.terminalHandle),
      hostScope: { kind: 'ssh', targetId: 'replacement-host' }
    } as never)

    await expect(
      call('orchestration.workerRelease', { dispatch: worker.dispatchId })
    ).resolves.toMatchObject({ state: 'retained', reason: 'identity_unproven' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    await expect(
      call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
    ).rejects.toMatchObject({
      code: 'worker_disposition_required',
      data: { dispatchIds: [worker.dispatchId] }
    })

    await call('orchestration.workerRetain', { dispatch: worker.dispatchId })
    await expect(
      call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
    ).resolves.toMatchObject({ acknowledged: delivery.deliveryId })
  })

  it('keeps unverifiable release intent behind the barrier until recovery settles it', async () => {
    setup()
    const worker = await startWorker()
    await reportWorkerDone(worker)
    const delivery = await readDelivery()
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))

    await expect(
      call('orchestration.workerRelease', { dispatch: worker.dispatchId })
    ).resolves.toMatchObject({ state: 'release_unknown', processAction: 'none' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    await expect(
      call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
    ).rejects.toMatchObject({
      code: 'worker_disposition_required',
      data: { dispatchIds: [worker.dispatchId] }
    })

    vi.mocked(runtime.showTerminal).mockImplementation(
      async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
    )
    await expect(
      call('orchestration.workerRelease', { dispatch: worker.dispatchId })
    ).resolves.toMatchObject({ state: 'released' })
    await expect(
      call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
    ).resolves.toMatchObject({ acknowledged: delivery.deliveryId })
  })

  it('allows old Delivery acknowledgment after public worker transfer', async () => {
    setup()
    const first = await startWorker()
    await reportWorkerDone(first)
    const delivery = await readDelivery()

    const second = await startWorker({ terminal: first.terminalHandle })
    expect(second.dispatchId).not.toBe(first.dispatchId)
    await expect(
      call('orchestration.workerRelease', { dispatch: first.dispatchId })
    ).resolves.toMatchObject({ state: 'retained', reason: 'ownership_transferred' })
    await expect(
      call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
    ).resolves.toMatchObject({ acknowledged: delivery.deliveryId })
  })

  it('keeps ownership provisional until a same-terminal transfer accepts input', async () => {
    setup()
    const first = await startWorker()
    await reportWorkerDone(first)
    const delivery = await readDelivery()
    const nextTask = db.createTask({ spec: 'pending transfer target', runId: activeRunId })
    let acceptInput: (() => void) | undefined
    vi.mocked(runtime.sendTerminalAgentPrompt).mockImplementationOnce(
      (handle) =>
        new Promise((resolve) => {
          acceptInput = () => resolve({ handle, accepted: true, bytesWritten: 1 })
        })
    )

    const starting = call('orchestration.workerStart', {
      task: nextTask.id,
      from: 'term_coord',
      terminal: first.terminalHandle
    })
    let currentOwner = ''
    await vi.waitFor(() => {
      currentOwner =
        db.getWorkerTerminalResourceFormerlyOwnedBy(first.dispatchId)?.owner_dispatch_id ?? ''
      expect(currentOwner).not.toBe('')
      expect(currentOwner).not.toBe(first.dispatchId)
    })
    await expect(
      call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
    ).rejects.toMatchObject({
      code: 'worker_disposition_required',
      data: { dispatchIds: [currentOwner] }
    })

    acceptInput?.()
    await expect(starting).resolves.toMatchObject({ state: 'ready' })
    await expect(
      call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
    ).resolves.toMatchObject({ acknowledged: delivery.deliveryId })
  })

  it('preserves active retention semantics for connected-server workers', async () => {
    setup()
    const worker = await startWorker()
    markWorkerFederated(worker)

    await expect(
      call('orchestration.workerRetain', { dispatch: worker.dispatchId })
    ).resolves.toMatchObject({ state: 'retained', reason: 'user_requested' })
    await reportWorkerDone(worker)
    const delivery = await readDelivery()
    await expect(
      call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
    ).resolves.toMatchObject({ acknowledged: delivery.deliveryId })
  })

  it('requires an explicit disposition for connected-server workers', async () => {
    setup()
    const worker = await startWorker()
    markWorkerFederated(worker)
    await reportWorkerDone(worker)
    const delivery = await readDelivery()

    await expect(
      call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
    ).rejects.toMatchObject({
      code: 'worker_disposition_required',
      data: { dispatchIds: [worker.dispatchId] }
    })
    await expect(
      call('orchestration.workerRelease', { dispatch: worker.dispatchId })
    ).resolves.toMatchObject({ state: 'retained', reason: 'federation_unsupported' })
    await expect(
      call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
    ).resolves.toMatchObject({ acknowledged: delivery.deliveryId })
  })

  it('persists connected-server retention across a database reopen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-federated-worker-disposition-'))
    const dbPath = join(dir, 'orchestration.db')
    try {
      setup(dbPath)
      const worker = await startWorker()
      markWorkerFederated(worker)
      await reportWorkerDone(worker)
      const delivery = await readDelivery()
      await expect(
        call('orchestration.workerRelease', { dispatch: worker.dispatchId })
      ).resolves.toMatchObject({ state: 'retained', reason: 'federation_unsupported' })

      db.close()
      dbOpen = false
      db = new OrchestrationDb(dbPath)
      dbOpen = true
      runtime.setOrchestrationDb(db)

      await expect(
        call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
      ).resolves.toMatchObject({ acknowledged: delivery.deliveryId })
    } finally {
      if (dbOpen) {
        db.close()
        dbOpen = false
      }
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the obligation when a same-terminal transfer fails before input acceptance', async () => {
    setup()
    const first = await startWorker()
    await reportWorkerDone(first)
    const delivery = await readDelivery()
    const nextTask = db.createTask({ spec: 'failed transfer target', runId: activeRunId })
    vi.mocked(runtime.sendTerminalAgentPrompt).mockRejectedValueOnce(
      new Error('dispatch input failed')
    )

    const failed = (await call('orchestration.workerStart', {
      task: nextTask.id,
      from: 'term_coord',
      terminal: first.terminalHandle
    })) as { dispatchId: string; state: string }
    expect(failed.state).toBe('failed')

    await expect(
      call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
    ).rejects.toMatchObject({
      code: 'worker_disposition_required',
      data: { dispatchIds: [failed.dispatchId] }
    })
    await call('orchestration.workerRetain', { dispatch: failed.dispatchId })
    await expect(
      call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
    ).resolves.toMatchObject({ acknowledged: delivery.deliveryId })
  })

  it('replays the barrier after reopening the database', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-worker-disposition-'))
    const dbPath = join(dir, 'orchestration.db')
    try {
      setup(dbPath)
      const worker = await startWorker()
      await reportWorkerDone(worker)
      const delivery = await readDelivery()

      db.close()
      dbOpen = false
      db = new OrchestrationDb(dbPath)
      dbOpen = true
      runtime.setOrchestrationDb(db)

      await expect(
        call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
      ).rejects.toMatchObject({
        code: 'worker_disposition_required',
        data: { dispatchIds: [worker.dispatchId] }
      })
      await call('orchestration.workerRetain', { dispatch: worker.dispatchId })
      await expect(
        call('orchestration.check', { terminal: 'term_coord', ack: delivery.deliveryId })
      ).resolves.toMatchObject({ acknowledged: delivery.deliveryId })
    } finally {
      if (dbOpen) {
        db.close()
        dbOpen = false
      }
      await rm(dir, { recursive: true, force: true })
    }
  })
})
