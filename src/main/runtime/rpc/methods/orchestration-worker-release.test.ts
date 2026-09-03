import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import type { RpcContext } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

describe('orchestration worker release', () => {
  let db: OrchestrationDb
  let dbOpen = false
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let activeRunId: string
  let inspectProcessLiveness: ReturnType<typeof vi.fn>

  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    dbOpen = true
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    inspectProcessLiveness = vi.fn().mockResolvedValue('live')
    ;(
      runtime as unknown as {
        inspectTerminalProcessIncarnationLiveness: typeof inspectProcessLiveness
      }
    ).inspectTerminalProcessIncarnationLiveness = inspectProcessLiveness
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord'
        ? coordinatorPaneKey
        : handle === 'term_worker' || handle === 'term_reminted'
          ? workerPaneKey
          : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' || handle === 'term_reminted' ? 'runtime_test:term_worker:1' : null
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle === 'term_worker' || handle === 'term_reminted'
        ? ({
            terminalHandle: handle,
            paneKey: workerPaneKey,
            processIncarnation: 'runtime_test:term_worker:1',
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
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_worker',
      worktreeId: 'repo::worktree',
      title: 'worker'
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1
    })
    vi.spyOn(runtime, 'getTerminalRunningTuiAgent').mockResolvedValue('codex')
    vi.spyOn(runtime, 'getExactWorkerProviderSession').mockReturnValue(null)
    vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
      handle: 'term_worker',
      status: 'running',
      tail: ['worker output line 1', 'worker output line 2'],
      truncated: false,
      nextCursor: '2'
    })
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: 'term_worker',
      tabId: 'tab-worker',
      ptyKilled: true
    } as never)
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    activeRunId = db.createRun({
      objective: 'Release test Run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
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

  function findMethod(name: string) {
    const method = ORCHESTRATION_METHODS.find((m) => m.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method
  }

  async function call(name: string, params: Record<string, unknown>) {
    const method = findMethod(name)
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, ctx)
  }

  async function startWorker(options: { terminal?: string } = {}): Promise<{
    taskId: string
    dispatchId: string
  }> {
    const task = db.createTask({ spec: 'release fixture task', runId: activeRunId })
    const result = (await call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      ...(options.terminal ? { terminal: options.terminal } : { agent: 'codex' })
    })) as { dispatchId: string; state: string }
    expect(result.state).toBe('ready')
    return { taskId: task.id, dispatchId: result.dispatchId }
  }

  function settle(taskId: string, dispatchId: string, outcome: 'succeeded' | 'failed'): void {
    const settlement = db.settleWorkerReport({
      taskId,
      dispatchId,
      outcome,
      result: `worker ${outcome}`
    })
    expect(settlement.action).toBe('settled')
  }

  async function startSettledWorker(
    outcome: 'succeeded' | 'failed' = 'succeeded',
    options: { terminal?: string } = {}
  ): Promise<{ taskId: string; dispatchId: string }> {
    const worker = await startWorker(options)
    settle(worker.taskId, worker.dispatchId, outcome)
    return worker
  }

  it('creates an owned resource for a fresh worker terminal', async () => {
    setup()
    const { dispatchId } = await startWorker()
    const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
    expect(resource).toMatchObject({
      ownership_state: 'owned',
      release_state: 'not_requested',
      terminal_handle: 'term_worker',
      pane_key: workerPaneKey,
      process_incarnation: 'runtime_test:term_worker:1'
    })
  })

  it('releases a succeeded worker: archives then closes exactly the agent terminal', async () => {
    setup()
    const { dispatchId } = await startSettledWorker('succeeded')

    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      processAction: string
      archive: { source: string | null; status: string | null } | null
    }

    expect(receipt).toMatchObject({
      state: 'released',
      processAction: 'closed_agent_terminal',
      archive: { source: 'terminal', status: 'captured' }
    })
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(runtime.closeTerminal).toHaveBeenCalledWith('term_worker')
    const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
    expect(resource?.release_state).toBe('released')
    expect(resource?.ownership_state).toBe('released')
    // Outcome is untouched by release.
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('succeeded')
  })

  it('releases a failed worker the same way', async () => {
    setup()
    const { dispatchId } = await startSettledWorker('failed')
    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
    }
    expect(receipt.state).toBe('released')
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('failed')
  })

  it('is idempotent: a duplicate release returns already_released without another close', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    await call('orchestration.workerRelease', { dispatch: dispatchId })
    const second = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      processAction: string
    }
    expect(second).toMatchObject({ state: 'already_released', processAction: 'none' })
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('rejects an active worker without recording release intent', async () => {
    setup()
    const { dispatchId } = await startWorker()
    await expect(call('orchestration.workerRelease', { dispatch: dispatchId })).rejects.toThrow(
      /only a settled worker can release/
    )
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('not_requested')
  })

  it('retains an explicitly reused external terminal without closing it', async () => {
    setup()
    const { dispatchId } = await startSettledWorker('succeeded', { terminal: 'term_worker' })
    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      reason?: string
    }
    expect(receipt).toMatchObject({ state: 'retained', reason: 'external_terminal' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('reconciles a dead external terminal without closing a process', async () => {
    setup()
    const { dispatchId } = await startSettledWorker('succeeded', { terminal: 'term_worker' })
    inspectProcessLiveness.mockResolvedValue('exited')

    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'released', processAction: 'none' })
    expect(inspectProcessLiveness).toHaveBeenCalledWith(
      'runtime_test:term_worker:1',
      JSON.stringify({ kind: 'local', hostId: 'local' })
    )
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'released',
      release_state: 'released'
    })
  })

  it('retains dead inventory evidence when persisted ownership history is invalid', async () => {
    setup()
    const { dispatchId } = await startSettledWorker('succeeded', { terminal: 'term_worker' })
    const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
    const raw = (
      db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }
    ).db
    raw
      .prepare('UPDATE worker_terminal_resources SET prior_owner_dispatch_ids = ? WHERE id = ?')
      .run('{invalid', resource?.id)
    inspectProcessLiveness.mockResolvedValue('exited')

    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'retained', processAction: 'none' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).not.toBe('released')
  })

  it('retains a user-taken-over terminal durably', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    const changed = (await call('orchestration.workerTerminalUserInput', {
      paneKey: workerPaneKey
    })) as { changed: number }
    expect(changed.changed).toBe(1)
    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      reason?: string
    }
    expect(receipt).toMatchObject({ state: 'retained', reason: 'user_takeover' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.ownership_state).toBe('user_owned')
  })

  it('reconciles a dead user-taken-over terminal without closing a process', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    await call('orchestration.workerTerminalUserInput', { paneKey: workerPaneKey })
    inspectProcessLiveness.mockResolvedValue('exited')

    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'released', processAction: 'none' })
    expect(inspectProcessLiveness).toHaveBeenCalledWith(
      'runtime_test:term_worker:1',
      JSON.stringify({ kind: 'local', hostId: 'local' })
    )
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'released',
      release_state: 'released'
    })
  })

  it.each(['stopped', 'abandoned'] as const)(
    'reconciles a dead %s worker without closing a process',
    async (state) => {
      setup()
      const { dispatchId } = await startWorker()
      if (state === 'stopped') {
        db.beginWorkerStop(dispatchId, runtime.getRuntimeId())
        db.settleWorkerStop(dispatchId)
      } else {
        db.abandonWorkerDispatch(dispatchId)
      }
      inspectProcessLiveness.mockResolvedValue('exited')

      await expect(
        call('orchestration.workerRelease', { dispatch: dispatchId })
      ).resolves.toMatchObject({ state: 'released', processAction: 'none' })
      expect(runtime.closeTerminal).not.toHaveBeenCalled()
      expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
        ownership_state: 'released',
        release_state: 'released'
      })
    }
  )

  it('lets user takeover cancel a release while output capture is pending', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    const pendingRead = deferred<Awaited<ReturnType<OrcaRuntimeService['readTerminal']>>>()
    vi.mocked(runtime.readTerminal).mockReturnValue(pendingRead.promise)

    const release = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() => expect(runtime.readTerminal).toHaveBeenCalledTimes(1))
    const changed = (await call('orchestration.workerTerminalUserInput', {
      paneKey: workerPaneKey
    })) as { changed: number }
    expect(changed.changed).toBe(1)
    pendingRead.resolve({
      handle: 'term_worker',
      status: 'running',
      tail: ['captured before takeover'],
      truncated: false,
      nextCursor: '1'
    })

    await expect(release).resolves.toMatchObject({ state: 'retained', reason: 'user_takeover' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalArchive(dispatchId)).toBeUndefined()
  })

  it('lets an explicit retain cancel a release while output capture is pending', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    const pendingRead = deferred<Awaited<ReturnType<OrcaRuntimeService['readTerminal']>>>()
    vi.mocked(runtime.readTerminal).mockReturnValue(pendingRead.promise)

    const release = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() => expect(runtime.readTerminal).toHaveBeenCalledTimes(1))
    await expect(
      call('orchestration.workerRetain', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'retained', reason: 'user_requested' })
    pendingRead.resolve({
      handle: 'term_worker',
      status: 'running',
      tail: ['captured before retention'],
      truncated: false,
      nextCursor: '1'
    })

    await expect(release).resolves.toMatchObject({ state: 'retained', reason: 'user_requested' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalArchive(dispatchId)).toBeUndefined()
  })

  it('does not claim retention succeeded after terminal close was committed', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    const pendingClose = deferred<Awaited<ReturnType<OrcaRuntimeService['closeTerminal']>>>()
    vi.mocked(runtime.closeTerminal).mockReturnValue(pendingClose.promise)

    const release = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() => expect(runtime.closeTerminal).toHaveBeenCalledTimes(1))
    await expect(
      call('orchestration.workerRetain', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'release_pending' })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('releasing')
    pendingClose.resolve({ handle: 'term_worker', tabId: 'tab-worker', ptyKilled: true })

    await expect(release).resolves.toMatchObject({ state: 'released' })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
  })

  it('never marks takeover for panes without an owned resource', async () => {
    setup()
    const changed = (await call('orchestration.workerTerminalUserInput', {
      paneKey: 'tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    })) as { changed: number }
    expect(changed.changed).toBe(0)
  })

  it('preserves takeover across a reminted tab key for the same pane leaf', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    const changed = (await call('orchestration.workerTerminalUserInput', {
      paneKey: 'tab_reminted:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    })) as { changed: number }

    expect(changed.changed).toBe(1)
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.ownership_state).toBe('user_owned')
  })

  it('retains when the exact process identity changed instead of closing', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.getTerminalProcessIncarnation).mockImplementation((handle) =>
      handle === 'term_worker' ? 'runtime_test:term_worker:2' : null
    )
    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      reason?: string
    }
    expect(receipt).toMatchObject({ state: 'retained', reason: 'identity_unproven' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('retains when the terminal host scope changed instead of closing', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.getOrchestrationDispatchAuthority).mockReturnValue({
      terminalHandle: 'term_worker',
      paneKey: workerPaneKey,
      processIncarnation: 'runtime_test:term_worker:1',
      hostScope: { kind: 'ssh', targetId: 'replacement-host' }
    } as never)

    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'retained', reason: 'identity_unproven' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('re-proves process identity after archive capture before closing', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    const pendingRead = deferred<Awaited<ReturnType<OrcaRuntimeService['readTerminal']>>>()
    vi.mocked(runtime.readTerminal).mockReturnValue(pendingRead.promise)

    const release = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() => expect(runtime.readTerminal).toHaveBeenCalledTimes(1))
    vi.mocked(runtime.getTerminalProcessIncarnation).mockImplementation((handle) =>
      handle === 'term_worker' ? 'runtime_test:term_worker:2' : null
    )
    pendingRead.resolve({
      handle: 'term_worker',
      status: 'running',
      tail: ['output from the old process'],
      truncated: false,
      nextCursor: '1'
    })

    await expect(release).resolves.toMatchObject({
      state: 'retained',
      reason: 'identity_unproven'
    })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('returns release_unknown when the terminal no longer resolves, then completes a retry', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      recovery?: string
    }
    expect(receipt.state).toBe('release_unknown')
    expect(receipt.recovery).toContain('worker-show')
    expect(runtime.closeTerminal).not.toHaveBeenCalled()

    vi.mocked(runtime.showTerminal).mockImplementation(
      async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
    )
    const retry = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
    }
    expect(retry.state).toBe('released')
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('retains the live terminal when output capture fails', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.readTerminal).mockRejectedValue(new Error('read exploded'))
    await expect(call('orchestration.workerRelease', { dispatch: dispatchId })).rejects.toThrow(
      /Output could not be preserved/
    )
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    // Durable intent survives for recovery.
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('requested')
  })

  it('marks release_unknown when the close itself fails', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.closeTerminal).mockRejectedValue(new Error('close exploded'))
    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      lastError?: string
    }
    expect(receipt.state).toBe('release_unknown')
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('unknown')
  })

  it('records an explicitly empty archive for an already-exited worker process', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.showTerminal).mockImplementation(
      async (handle) => ({ handle, worktreeId: 'repo::worktree', connected: false }) as never
    )
    vi.mocked(runtime.readTerminal).mockResolvedValue({
      handle: 'term_worker',
      status: 'exited',
      tail: [],
      truncated: false,
      nextCursor: null
    })
    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      processAction: string
      archive: { status: string | null } | null
    }
    expect(receipt).toMatchObject({
      state: 'released',
      processAction: 'closed_exited_terminal',
      archive: { status: 'empty' }
    })
  })

  it('keeps a bounded tail when one terminal line exceeds the archive budget', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    const suffix = 'meaningful-tail'
    vi.mocked(runtime.readTerminal).mockResolvedValue({
      handle: 'term_worker',
      status: 'running',
      tail: [`${'x'.repeat(300_000)}${suffix}`],
      truncated: false,
      nextCursor: '1'
    })

    const release = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      archive: { status: string | null } | null
    }
    const read = (await call('orchestration.workerRead', { dispatch: dispatchId })) as {
      terminal: { tail: string[]; truncated: boolean }
      warnings: string[]
    }

    expect(release.archive?.status).toBe('captured')
    expect(read.terminal.tail).toHaveLength(1)
    expect(read.terminal.tail[0]).toMatch(new RegExp(`${suffix}$`))
    expect(read.terminal.truncated).toBe(true)
    expect(read.warnings).not.toContain(
      'The live terminal buffer was empty at release; structured transcript output was unavailable.'
    )
  })

  it('serves the frozen redacted archive through worker-read after release, with cursors', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.readTerminal).mockResolvedValue({
      handle: 'term_worker',
      status: 'running',
      tail: ['first line', `capability dcap_${'a'.repeat(24)} leaked`, 'last line'],
      draft: `send --dispatch-capability dcap_${'b'.repeat(24)}`,
      truncated: false,
      nextCursor: '3'
    })
    await call('orchestration.workerRelease', { dispatch: dispatchId })
    vi.mocked(runtime.readTerminal).mockClear()

    const page1 = (await call('orchestration.workerRead', {
      dispatch: dispatchId,
      limit: 2
    })) as {
      archived?: boolean
      terminal: { tail: string[]; draft?: string }
      cursor: string | null
    }
    expect(page1.terminal.tail).toEqual([
      'first line',
      'capability [dispatch capability redacted] leaked'
    ])
    expect(page1.terminal.draft).toBe('send --dispatch-capability [dispatch capability redacted]')
    expect(page1.cursor).not.toBeNull()

    const page2 = (await call('orchestration.workerRead', {
      dispatch: dispatchId,
      cursor: page1.cursor as string
    })) as { terminal: { tail: string[]; draft?: string }; cursor: string | null }
    expect(page2.terminal.tail).toEqual(['last line'])
    expect(page2.terminal.draft).toBeUndefined()
    expect(page2.cursor).toBeNull()
    // The live terminal is never consulted after release.
    expect(runtime.readTerminal).not.toHaveBeenCalled()
  })

  it('reads an immutable transcript snapshot after the provider file disappears', async () => {
    setup()
    const directory = await mkdtemp(join(tmpdir(), 'orca-worker-release-snapshot-'))
    const transcriptPath = join(directory, 'rollout.jsonl')
    try {
      await writeFile(
        transcriptPath,
        `${JSON.stringify({
          timestamp: '2026-08-03T12:00:00.000Z',
          type: 'event_msg',
          payload: { id: 'snapshot-message', type: 'agent_message', message: 'frozen output' }
        })}\n`
      )
      vi.mocked(runtime.getExactWorkerProviderSession).mockReturnValue({
        agent: 'codex',
        processIncarnation: 'runtime_test:term_worker:1',
        providerSession: {
          key: 'codex:snapshot-session',
          id: 'snapshot-session',
          transcriptPath
        }
      } as never)
      const { dispatchId } = await startSettledWorker()
      await call('orchestration.workerRelease', { dispatch: dispatchId })
      await rm(transcriptPath)

      await expect(
        call('orchestration.workerRead', { dispatch: dispatchId })
      ).resolves.toMatchObject({
        archived: true,
        source: 'transcript',
        transcript: {
          messages: [{ id: 'snapshot-message', blocks: [{ type: 'text', text: 'frozen output' }] }]
        }
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a legacy live-terminal cursor after output moves to the archive', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    await call('orchestration.workerRelease', { dispatch: dispatchId })

    await expect(
      call('orchestration.workerRead', { dispatch: dispatchId, cursor: 1 })
    ).rejects.toThrow(/source changed/i)
  })

  it('recovers archive metadata when a prior attempt committed only the archive row', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    const requested = db.requestWorkerTerminalRelease(dispatchId)
    expect(requested.disposition).toBe('requested')
    if (requested.disposition !== 'requested') {
      throw new Error('release request was not recorded')
    }
    db.storeWorkerTerminalArchive({
      dispatchId,
      resourceId: requested.resource.id,
      kind: 'terminal_tail',
      content: JSON.stringify({
        lines: ['archive survived the interrupted attempt'],
        truncated: false,
        terminalStatus: 'running',
        warnings: []
      })
    })

    const release = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      archive: { source: string | null; status: string | null } | null
    }

    expect(release.archive).toEqual({ source: 'terminal', status: 'captured' })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      archive_source: 'terminal',
      archive_status: 'captured'
    })
  })

  it('transfers ownership on exact reuse and fences release through the old Dispatch', async () => {
    setup()
    const first = await startSettledWorker('succeeded')
    const originalResource = db.getWorkerTerminalResourceByOwner(first.dispatchId)
    expect(originalResource?.ownership_state).toBe('owned')

    const second = await startWorker({ terminal: 'term_reminted' })
    const transferred = db.getWorkerTerminalResourceByOwner(second.dispatchId)
    expect(transferred?.id).toBe(originalResource?.id)
    expect(transferred?.terminal_handle).toBe('term_reminted')
    expect(db.getWorkerTerminalResourceByOwner(first.dispatchId)).toBeUndefined()

    inspectProcessLiveness.mockResolvedValueOnce('exited')
    const oldRelease = (await call('orchestration.workerRelease', {
      dispatch: first.dispatchId
    })) as { state: string; reason?: string }
    expect(oldRelease).toMatchObject({ state: 'retained', reason: 'ownership_transferred' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()

    settle(second.taskId, second.dispatchId, 'succeeded')
    const newRelease = (await call('orchestration.workerRelease', {
      dispatch: second.dispatchId
    })) as { state: string }
    expect(newRelease.state).toBe('released')
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(runtime.closeTerminal).toHaveBeenCalledWith('term_reminted')
  })

  it('reconciles dead transferred ownership after the current owner settles', async () => {
    setup()
    const first = await startSettledWorker('succeeded')
    const second = await startWorker({ terminal: 'term_reminted' })
    settle(second.taskId, second.dispatchId, 'succeeded')
    inspectProcessLiveness.mockResolvedValue('exited')

    await expect(
      call('orchestration.workerRelease', { dispatch: first.dispatchId })
    ).resolves.toMatchObject({ state: 'released', processAction: 'none' })
    expect(inspectProcessLiveness).toHaveBeenCalledWith(
      'runtime_test:term_worker:1',
      JSON.stringify({ kind: 'local', hostId: 'local' })
    )
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner(second.dispatchId)).toMatchObject({
      ownership_state: 'released',
      release_state: 'released'
    })
  })

  it('rejects exact reuse after release intent instead of closing the new worker', async () => {
    setup()
    const first = await startSettledWorker('succeeded')
    expect(db.requestWorkerTerminalRelease(first.dispatchId).disposition).toBe('requested')
    const nextTask = db.createTask({ spec: 'racing reuse', runId: activeRunId })

    const attempted = (await call('orchestration.workerStart', {
      task: nextTask.id,
      from: 'term_coord',
      terminal: 'term_worker'
    })) as { state: string; lastError?: string }

    expect(attempted).toMatchObject({ state: 'failed' })
    expect(attempted.lastError).toMatch(/release.*progress/i)
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    await expect(
      call('orchestration.workerRelease', { dispatch: first.dispatchId })
    ).resolves.toMatchObject({ state: 'released' })
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('retains when persisted state has another resource for the exact terminal identity', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    const raw = (
      db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }
    ).db
    raw
      .prepare(
        `INSERT INTO worker_terminal_resources (
           id, origin_dispatch_id, owner_dispatch_id, terminal_handle, pane_key,
           process_incarnation, host_scope, ownership_state, release_state, retained_reason
         ) VALUES (
           'wtr_conflict', 'ctx_conflict', 'ctx_conflict', 'term_reminted', ?, ?, ?,
           'external', 'retained', 'legacy_ambiguous'
         )`
      )
      .run(
        workerPaneKey,
        'runtime_test:term_worker:1',
        JSON.stringify({ kind: 'local', hostId: 'local' })
      )

    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'retained', reason: 'identity_unproven' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('worker-retain records a durable user exception that release can later replace', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    const retained = (await call('orchestration.workerRetain', { dispatch: dispatchId })) as {
      state: string
      reason?: string
    }
    expect(retained).toMatchObject({ state: 'retained', reason: 'user_requested' })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('retained')

    const release = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
    }
    expect(release.state).toBe('released')
  })

  it('worker-list separates terminal accounting from Task outcome', async () => {
    setup()
    const active = await startWorker()
    const perWorkerLookup = vi.spyOn(db, 'getWorkerTerminalResourceByOwner')
    perWorkerLookup.mockClear()
    const result1 = (await call('orchestration.workerList', { run: activeRunId })) as {
      workers: { dispatchId: string; terminalState: string | null; workerState: string }[]
      counts: Record<string, number>
    }
    expect(result1.workers).toHaveLength(1)
    expect(result1.workers[0]).toMatchObject({
      dispatchId: active.dispatchId,
      terminalState: 'active',
      workerState: 'ready'
    })
    expect(perWorkerLookup).not.toHaveBeenCalled()

    settle(active.taskId, active.dispatchId, 'succeeded')
    const result2 = (await call('orchestration.workerList', {
      run: activeRunId,
      terminalState: 'reclaimable'
    })) as { workers: { dispatchId: string }[]; counts: Record<string, number> }
    expect(result2.workers.map((worker) => worker.dispatchId)).toEqual([active.dispatchId])
    expect(result2.counts).toMatchObject({ reclaimable: 1 })

    await call('orchestration.workerRelease', { dispatch: active.dispatchId })
    const result3 = (await call('orchestration.workerList', { run: activeRunId })) as {
      workers: { terminalState: string | null; workerState: string }[]
    }
    expect(result3.workers[0]).toMatchObject({
      terminalState: 'released',
      workerState: 'succeeded'
    })
  })

  it('reports abandoned workers as retained instead of reclaimable', async () => {
    setup()
    const { dispatchId } = await startWorker()
    await call('orchestration.workerAbandon', { dispatch: dispatchId })

    const listed = (await call('orchestration.workerList', { run: activeRunId })) as {
      workers: { dispatchId: string; terminalState: string | null }[]
    }

    expect(listed.workers).toContainEqual(
      expect.objectContaining({ dispatchId, terminalState: 'retained' })
    )
    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({
      state: 'retained',
      reason: 'identity_unproven',
      processAction: 'none'
    })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('worker-show exposes the terminal resource', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    const shown = (await call('orchestration.workerShow', { dispatch: dispatchId })) as {
      terminalResource: { ownershipState: string; releaseState: string } | null
    }
    expect(shown.terminalResource).toMatchObject({
      ownershipState: 'owned',
      releaseState: 'not_requested'
    })
  })
})
