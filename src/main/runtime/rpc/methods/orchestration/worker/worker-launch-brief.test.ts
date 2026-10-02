import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizePromptField } from '../../../../../../shared/agent-status-field-normalization'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

describe('worker-start with the brief on the launch command line', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  afterEach(() => h.cleanup())

  it("offers the brief to the carry rule as main's paste caller, and pastes nothing it carried", async () => {
    h.setup()
    const { dispatchId } = await h.startWorker({ agent: 'codex' })

    expect(h.runtime.createTerminal).toHaveBeenCalledWith(
      'id:repo::worktree',
      expect.objectContaining({
        startupAgent: 'codex',
        preAllocatedHandle: 'term_worker',
        startupPromptPaste: 'once-agent-runs',
        onStartupPromptCarry: expect.any(Function)
      })
    )
    const options = vi.mocked(h.runtime.createTerminal).mock.calls[0][1]
    expect(options).not.toHaveProperty('launchFile')
    expect(options?.startupPrompt).toContain('release fixture task')
    expect(options?.startupPrompt).toContain(dispatchId)
    expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    expect(h.runtime.observeTerminalLaunchTurnStart).toHaveBeenCalled()
  })

  // Why: every status reader finds a worker by its preamble; the brief is the prompt the agent's
  // hook reports, so it publishes the compact form main published for the pasted brief.
  it("publishes the brief as the worker's status prompt, compacted to its task as main did", async () => {
    h.setup()
    await h.startWorker({ agent: 'claude' })

    const prompt = vi.mocked(h.runtime.createTerminal).mock.calls[0][1]?.startupPrompt ?? ''
    const status = normalizePromptField(prompt)
    expect(status).toMatch(/^You are working inside Orca, a multi-agent IDE\./)
    expect(status).toContain('=== TASK === release fixture task')
    expect(status).not.toContain('orca-launch-file')
  })

  // Why: a host whose line cannot carry the brief whole (a Windows shell, an SSH host with a WSL
  // shell) gets main's paste after readiness instead of a refused launch file.
  it('pastes the brief once the agent is ready where the carry rule leaves it', async () => {
    h.setup()
    vi.mocked(h.runtime.createTerminal).mockImplementation(async (_selector, options) => {
      options?.onStartupPromptCarry?.(false)
      return { handle: 'term_worker', worktreeId: 'repo::worktree', title: 'worker' }
    })

    const { dispatchId } = await h.startWorker({ agent: 'codex' })

    expect(h.runtime.observeTerminalLaunchTurnStart).not.toHaveBeenCalled()
    expect(h.runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
    expect(vi.mocked(h.runtime.sendTerminalAgentPrompt).mock.calls[0][1]).toContain(dispatchId)
    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('ready')
  })

  it('binds the dispatch to the handle the brief names, and only after the spawn', async () => {
    h.setup()
    let boundAtSpawn: unknown = 'unset'
    let brief: string | undefined
    vi.mocked(h.runtime.createTerminal).mockImplementation(async (_selector, options) => {
      brief = options?.startupPrompt
      options?.onStartupPromptCarry?.(true)
      boundAtSpawn = h.db.db
        .prepare('SELECT id FROM dispatch_contexts WHERE assignee_handle = ?')
        .get('term_worker')
      return { handle: 'term_worker', worktreeId: 'repo::worktree', title: 'worker' }
    })

    const { dispatchId } = await h.startWorker({ agent: 'codex' })

    expect(brief).toContain('--from term_worker')
    expect(boundAtSpawn).toBeUndefined()
    expect(
      h.db.db
        .prepare('SELECT id FROM dispatch_contexts WHERE assignee_handle = ?')
        .get('term_worker')
    ).toEqual({ id: dispatchId })
  })

  // Why: the terminal is live with the brief on its line, so a retry must not run the task twice.
  it('fails a start whose terminal lost the handle its brief names, closing that terminal', async () => {
    h.setup()
    vi.mocked(h.runtime.createTerminal).mockImplementation(async (_selector, options) => {
      options?.onStartupPromptCarry?.(true)
      return { handle: 'term_adopted', worktreeId: 'repo::worktree', title: 'worker' }
    })
    const task = h.db.createTask({ spec: 'adopted pane', runId: h.activeRunId })

    await expect(
      h.call('orchestration.workerStart', { task: task.id, from: 'term_coord', agent: 'codex' })
    ).resolves.toMatchObject({
      state: 'failed',
      lastError: 'Worker terminal did not keep its pre-allocated handle.'
    })
    expect(h.runtime.closeTerminal).toHaveBeenCalledWith('term_adopted')
  })

  it("names the CLI command predicted for the worker's own terminal", async () => {
    h.setup()
    vi.mocked(h.runtime.predictOrchestrationCliCommandForSpawn).mockResolvedValue('orca-ide')

    await h.startWorker({ agent: 'codex' })

    expect(h.runtime.predictOrchestrationCliCommandForSpawn).toHaveBeenCalledWith({
      worktreeId: 'repo::worktree'
    })
    const brief = vi.mocked(h.runtime.createTerminal).mock.calls[0][1]?.startupPrompt
    expect(brief).toContain('orca-ide orchestration send')
  })

  it('reads a turn the launch observation did not see as unknown, not ready', async () => {
    h.setup()
    vi.mocked(h.runtime.observeTerminalLaunchTurnStart).mockResolvedValue('unobserved')
    const task = h.db.createTask({ spec: 'unobserved launch', runId: h.activeRunId })

    const receipt = await h.call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'codex'
    })
    expect(receipt).toMatchObject({ state: 'outcome_unknown', turnStart: 'unobserved' })
    // Why: the brief rode the command line; there is no composer to hold it, nor a 30 s paste window.
    expect(receipt).toMatchObject({
      lastError: expect.stringContaining("rode codex's launch command line")
    })
    expect(receipt).not.toMatchObject({ lastError: expect.stringMatching(/composer|up to 30s/) })
  })

  // Why: a launch whose hooks give no proof is judged on its own evidence, as main judged it.
  describe('a launch proven only by the agent holding its terminal', () => {
    function startProvenByForeground(spec: string) {
      vi.mocked(h.runtime.observeTerminalLaunchTurnStart).mockResolvedValue('unsupported')
      const task = h.db.createTask({ spec, runId: h.activeRunId })
      return h.call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex'
      })
    }

    it('is ready, saying no turn start was observable', async () => {
      h.setup()
      await expect(startProvenByForeground('ready worker')).resolves.toMatchObject({
        state: 'ready',
        turnStart: 'unsupported'
      })
    })

    // Why pinned: the observer reads no dialog on screen before it says so; settling here again
    // put the receipt seconds behind main with hooks off.
    it('is ready at once, without waiting on the startup dialog watch', async () => {
      h.setup()
      vi.mocked(h.runtime.waitForTerminal).mockReturnValue(new Promise(() => {}))
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      try {
        let receipt: unknown = 'pending'
        void startProvenByForeground('fast worker').then((value) => {
          receipt = value
        })
        await vi.advanceTimersByTimeAsync(100)
        expect(receipt).toMatchObject({ state: 'ready', turnStart: 'unsupported' })
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // Why: main's readiness wait failed a start whose agent died at launch; the host can prove it.
  it('fails and tears down a start whose agent the host proves exited at launch', async () => {
    h.setup()
    vi.mocked(h.runtime.observeTerminalLaunchTurnStart).mockResolvedValue('exited')
    const task = h.db.createTask({ spec: 'crashing worker', runId: h.activeRunId })

    await expect(
      h.call('orchestration.workerStart', { task: task.id, from: 'term_coord', agent: 'codex' })
    ).resolves.toMatchObject({
      state: 'failed',
      failedStage: 'turn_observation',
      lastError: expect.stringContaining('Agent exited before its first turn started')
    })
    expect(h.db.getTask(task.id)?.status).toBe('failed')
  })

  it('offers the brief to an agent that does not read a launch file too', async () => {
    h.setup()
    const task = h.db.createTask({ spec: 'gemini brief', runId: h.activeRunId })
    await h.call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'gemini'
    })
    expect(h.runtime.createTerminal).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        startupPrompt: expect.stringContaining('gemini brief'),
        startupPromptPaste: 'once-agent-runs'
      })
    )
    expect(h.runtime.observeTerminalLaunchTurnStart).toHaveBeenCalled()
    expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('still reports a dialog that paints after the agent first looked ready', async () => {
    h.setup()
    vi.mocked(h.runtime.observeTerminalLaunchTurnStart).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('unobserved'), 1_500))
    )
    vi.mocked(h.runtime.waitForTerminal)
      .mockResolvedValueOnce({
        handle: 'term_worker',
        condition: 'tui-idle',
        satisfied: true,
        status: 'running',
        exitCode: null
      })
      .mockResolvedValue({
        handle: 'term_worker',
        condition: 'tui-idle',
        satisfied: false,
        status: 'running',
        exitCode: null,
        blockedReason: 'codex-update-prompt'
      })
    const task = h.db.createTask({ spec: 'late dialog', runId: h.activeRunId })

    await expect(
      h.call('orchestration.workerStart', { task: task.id, from: 'term_coord', agent: 'codex' })
    ).resolves.toMatchObject({
      state: 'outcome_unknown',
      stage: 'turn_start_blocked',
      lastError: expect.stringContaining('codex-update-prompt')
    })
    expect(h.runtime.waitForTerminal).toHaveBeenLastCalledWith(
      'term_worker',
      expect.objectContaining({ launchReadiness: true })
    )
  })

  it('reports a start blocked on a startup dialog as unknown, keeping its terminal bound', async () => {
    h.setup()
    vi.mocked(h.runtime.observeTerminalLaunchTurnStart).mockReturnValue(new Promise(() => {}))
    vi.mocked(h.runtime.waitForTerminal).mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      exitCode: null,
      blockedReason: 'codex-update-prompt'
    })
    const task = h.db.createTask({ spec: 'blocked launch', runId: h.activeRunId })

    const receipt = await h.call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'codex'
    })
    expect(receipt).toMatchObject({
      state: 'outcome_unknown',
      stage: 'turn_start_blocked',
      lastError: expect.stringContaining('Agent startup blocked: codex-update-prompt')
    })
    expect(
      h.db.db
        .prepare('SELECT assignee_handle FROM dispatch_contexts WHERE task_id = ?')
        .get(task.id)
    ).toEqual({ assignee_handle: 'term_worker' })
  })

  // Why stop, not abandon: abandon frees the task for a retry but leaves the brief armed behind
  // the dialog, so answering it later would run the task twice.
  it('steers a blocked start to worker-stop, which closes the terminal holding the brief', async () => {
    h.setup()
    vi.mocked(h.runtime.observeTerminalLaunchTurnStart).mockReturnValue(new Promise(() => {}))
    vi.mocked(h.runtime.waitForTerminal).mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      exitCode: null,
      blockedReason: 'codex-update-prompt'
    })
    const task = h.db.createTask({ spec: 'blocked launch', runId: h.activeRunId })
    const receipt = await h.call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'codex'
    })
    expect(receipt).toMatchObject({
      nextCommands: expect.arrayContaining([
        expect.stringMatching(/^orca orchestration worker-stop --dispatch \S+ --json$/)
      ]),
      lastError: expect.stringMatching(/If the user answers the dialog.*worker-stop/)
    })
    expect(JSON.stringify(receipt)).not.toContain('worker-abandon')
    if (typeof receipt !== 'object' || receipt === null || !('dispatchId' in receipt)) {
      throw new Error('worker-start returned no dispatch')
    }
    const dispatchId = String(receipt.dispatchId)

    await expect(
      h.call('orchestration.workerStop', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'stopped', processAction: 'closed_agent_terminal' })
    expect(h.runtime.closeTerminal).toHaveBeenCalledWith('term_worker')
  })

  it('keeps the paste for an agent that takes its prompt only after start', async () => {
    h.setup()
    vi.spyOn(h.runtime, 'waitForFreshWorkerComposer').mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    await h.startWorker({ agent: 'zcode' })

    expect(vi.mocked(h.runtime.createTerminal).mock.calls[0][1]).not.toHaveProperty('startupPrompt')
    expect(h.runtime.sendTerminalAgentPrompt).toHaveBeenCalledTimes(1)
  })
})
