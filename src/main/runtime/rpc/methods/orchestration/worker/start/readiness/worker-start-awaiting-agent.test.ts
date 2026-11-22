/** A launch not ready at worker-start's budget stays open: its brief goes in only once the agent is ready,
 *  a screen only a person can answer is told once, and a start still not ready later fails once. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalPromptDelivery } from '../../../../../../../../shared/terminal/runtime/runtime-terminal-send-contract'
import type { RuntimeTerminalWait } from '../../../../../../../../shared/terminal/runtime/runtime-terminal-contracts'
import { createOrchestrationWorkerReleaseHarness } from '../../testing/worker-release.test-support'

const STARTED: RuntimeTerminalPromptDelivery = {
  requestId: 'req',
  stages: ['input_accepted', 'turn_started'],
  provider: 'claude',
  observation: 'supported',
  processIncarnation: 'runtime_test:term_worker:1',
  generation: 1,
  baselineWorkingSequence: 0
}

const READY: RuntimeTerminalWait = {
  handle: 'term_worker',
  condition: 'tui-idle',
  satisfied: true,
  status: 'running',
  exitCode: null
}

const THEME_PICKER: RuntimeTerminalWait = {
  ...READY,
  satisfied: false,
  blockedReason: 'agent-startup-menu-prompt'
}

describe('a worker start whose agent is not ready in time', () => {
  const h = createOrchestrationWorkerReleaseHarness()
  const dirs: string[] = []

  afterEach(() => {
    h.cleanup()
    vi.unstubAllEnvs()
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const mail = (subject: string) =>
    h.db
      .getUnreadRunMailbox(h.activeRunId, 100, ['escalation'])
      .filter((message) => message.subject === subject)

  let paint: () => void = () => {}

  /** A fresh Claude launch whose idle wait answers `first`, then `later` once the pane repaints or is asked again. */
  function launch(first: RuntimeTerminalWait | 'timeout', later: Promise<RuntimeTerminalWait>) {
    vi.spyOn(h.runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_worker',
      worktreeId: 'repo::worktree',
      title: 'worker',
      ptyId: 'pty-worker',
      incarnationId: 'inc-1'
    })
    vi.spyOn(h.runtime, 'readRecentTerminalOutput').mockReturnValue('')
    vi.spyOn(h.runtime, 'subscribeToTerminalData').mockImplementation((_ptyId, listener) => {
      paint = () => listener('repaint')
      return () => {}
    })
    vi.spyOn(h.runtime, 'readTerminal').mockResolvedValue({
      handle: 'term_worker',
      status: 'running',
      tail: ['Choose the text style that looks best with your terminal'],
      truncated: false,
      nextCursor: '1'
    })
    const idle = vi.spyOn(h.runtime, 'waitForTerminal')
    if (first === 'timeout') {
      idle.mockRejectedValueOnce(new Error('timeout'))
    } else {
      idle.mockResolvedValueOnce(first)
    }
    idle.mockReturnValue(later)
    vi.spyOn(h.runtime, 'waitForFreshWorkerComposer').mockRejectedValue(new Error('timeout'))
    vi.spyOn(h.runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1,
      prompt: STARTED
    })
    vi.spyOn(h.runtime, 'observeTerminalAgentPrompt').mockResolvedValue(STARTED)
  }

  async function start(): Promise<{ state: unknown; dispatchId: string; next: unknown }> {
    const task = h.db.createTask({ spec: 'slow start', runId: h.activeRunId })
    const receipt = (await h.call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'claude'
    })) as { state?: unknown; dispatchId?: unknown; next?: unknown }
    return { state: receipt.state, dispatchId: String(receipt.dispatchId), next: receipt.next }
  }

  function deferred(): { promise: Promise<RuntimeTerminalWait>; resolve: () => void } {
    let resolve: () => void = () => {}
    const promise = new Promise<RuntimeTerminalWait>((done) => {
      resolve = () => done(READY)
    })
    return { promise, resolve }
  }

  it('returns at once with its live Dispatch, and types the brief only once the agent is ready', async () => {
    h.setup()
    const ready = deferred()
    launch('timeout', ready.promise)

    const { state, dispatchId, next } = await start()

    expect(state).toBe('starting')
    expect(next).toContain(`Dispatch ${dispatchId}`)
    expect(next).toContain("Don't start this task again")
    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('starting')
    expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()

    ready.resolve()
    await vi.waitFor(() => expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('ready'))
    expect(h.runtime.sendTerminalAgentPrompt).toHaveBeenCalledTimes(1)
    expect(h.db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
  })

  it('asks for a person once on a startup screen, and types the brief once it is answered', async () => {
    h.setup()
    const answered = deferred()
    launch(THEME_PICKER, answered.promise)

    const { state, dispatchId } = await start()
    await vi.waitFor(() =>
      expect(mail('Worker needs a person before it can start')).toHaveLength(1)
    )

    expect(state).toBe('starting')
    const [alert] = mail('Worker needs a person before it can start')
    expect(alert?.body).toContain('its agent is showing a startup menu')
    expect(alert?.body).toContain('Choose the text style that looks best with your terminal')
    expect(alert?.body).toContain(`orchestration worker-stop --dispatch ${dispatchId}`)
    expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()

    paint()
    answered.resolve()
    await vi.waitFor(() => expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('ready'))
    expect(h.runtime.sendTerminalAgentPrompt).toHaveBeenCalledTimes(1)
    expect(mail('Worker needs a person before it can start')).toHaveLength(1)
  })

  it('fails once, with its screen and its terminal left open, when the agent never becomes ready', async () => {
    vi.stubEnv('ORCA_WORKER_START_READY_DEADLINE_MS', '1')
    h.setup()
    launch('timeout', Promise.reject(new Error('timeout')))
    const close = vi.spyOn(h.runtime, 'closeTerminal')

    const { dispatchId } = await start()
    await vi.waitFor(() => expect(mail('Worker never became ready')).toHaveLength(1))

    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('failed')
    expect(h.db.getDispatchContextById(dispatchId)?.status).toBe('failed')
    const [alert] = mail('Worker never became ready')
    expect(alert?.body).toContain('Orca never typed its brief')
    expect(alert?.body).toContain('Choose the text style that looks best with your terminal')
    expect(alert?.body).toContain(`orchestration worker-release --dispatch ${dispatchId}`)
    expect(close).not.toHaveBeenCalled()
    expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('can be stopped while it waits, and then types nothing', async () => {
    h.setup()
    const ready = deferred()
    launch('timeout', ready.promise)
    const close = vi
      .spyOn(h.runtime, 'closeTerminal')
      .mockResolvedValue({ handle: 'term_worker', tabId: 'tab', ptyKilled: true })
    const { dispatchId } = await start()

    await h.call('orchestration.workerStop', { dispatch: dispatchId })
    ready.resolve()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('stopped')
    expect(close).toHaveBeenCalledWith('term_worker')
    expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('fails with one report when Orca restarts while it waits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-awaiting-agent-'))
    dirs.push(dir)
    h.setup({ userDataDir: dir })
    launch('timeout', new Promise(() => {}))
    const { dispatchId } = await start()

    h.restart()
    await h.runtime.reportUnconfirmedWorkerStart(dispatchId)
    await h.runtime.reportUnconfirmedWorkerStart(dispatchId)

    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('failed')
    const reports = mail('Worker never became ready')
    expect(reports).toHaveLength(1)
    expect(reports[0]?.body).toContain('Orca restarted while it waited for its agent')
  })
})
