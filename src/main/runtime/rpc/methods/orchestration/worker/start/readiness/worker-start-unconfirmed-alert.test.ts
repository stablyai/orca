/** A start whose turn Orca never saw begin reaches its coordinator once, live or after a restart. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalPromptDelivery } from '../../../../../../../../shared/terminal/runtime/runtime-terminal-send-contract'
import { getActiveDispatchForTask } from '../../../../../../orchestration/db/dispatch-context/task-dispatch-reconciliation'
import { observeWorker } from '../../../../../../orchestration/workers/turn-stops/worker-presence-report'
import { createOrchestrationWorkerReleaseHarness } from '../../testing/worker-release.test-support'

const SUBJECT = "Worker's brief may not have been submitted"

function typedPrompt(
  stages: RuntimeTerminalPromptDelivery['stages']
): RuntimeTerminalPromptDelivery {
  return {
    requestId: 'req',
    stages,
    provider: 'codex',
    observation: 'supported',
    processIncarnation: 'runtime_test:term_worker:1',
    generation: 1,
    baselineWorkingSequence: 0
  }
}

describe('an unconfirmed worker start', () => {
  const h = createOrchestrationWorkerReleaseHarness()
  const dirs: string[] = []

  afterEach(() => {
    h.cleanup()
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const alerts = () =>
    h.db
      .getUnreadRunMailbox(h.activeRunId, 100, ['escalation'])
      .filter((message) => message.subject === SUBJECT)

  async function start(): Promise<{ state: unknown; dispatchId: string }> {
    const task = h.db.createTask({ spec: 'unconfirmed start', runId: h.activeRunId })
    const receipt: unknown = await h.call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'codex'
    })
    const dispatchId = getActiveDispatchForTask(h.db, task.id)?.id
    if (!receipt || typeof receipt !== 'object' || !('state' in receipt) || !dispatchId) {
      throw new Error('worker-start returned no Dispatch')
    }
    return { state: receipt.state, dispatchId }
  }

  function typedButNeverStarted(): void {
    vi.spyOn(h.runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1,
      prompt: typedPrompt(['input_accepted'])
    })
    vi.spyOn(h.runtime, 'observeTerminalAgentPrompt').mockResolvedValue(
      typedPrompt(['input_accepted'])
    )
  }

  it('tells the coordinator once, with the screen and how to submit or stop it', async () => {
    h.setup()
    typedButNeverStarted()
    vi.spyOn(h.runtime, 'readTerminal').mockResolvedValue({
      handle: 'term_worker',
      status: 'running',
      tail: ['worker output line 1', 'worker output line 2'],
      draft: '[Pasted text #1 +40 lines]',
      truncated: false,
      nextCursor: '2'
    })
    const { state, dispatchId } = await start()
    await vi.waitFor(() => expect(alerts()).toHaveLength(1))

    expect(state).toBe('outcome_unknown')
    expect(alerts()[0]?.body).toContain('Text waiting in its prompt: [Pasted text #1 +40 lines]')
    const [alert] = alerts()
    expect(alert?.body).toContain("Your worker's brief may not have been submitted; check it.")
    expect(alert?.body).toContain('worker output line 2')
    expect(alert?.body).toContain('`terminal send --terminal term_worker --enter`')
    expect(alert?.body).toContain(`\`orchestration worker-stop --dispatch ${dispatchId}\``)
    await h.runtime.reportUnconfirmedWorkerStart(dispatchId)
    expect(alerts()).toHaveLength(1)
  })

  it('flips to started when its turn begins late, and is not reported again', async () => {
    h.setup()
    typedButNeverStarted()
    const { dispatchId } = await start()
    await vi.waitFor(() => expect(alerts()).toHaveLength(1))
    const dispatch = h.db.getDispatchContextById(dispatchId)!

    observeWorker(
      h.db,
      { kind: 'local', dispatch },
      { presence: 'working' },
      {
        getDb: () => h.db,
        isWaitingForMail: () => false,
        notify: () => {}
      }
    )

    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('ready')
    expect(h.db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
    expect(h.db.getTask(dispatch.task_id)?.status).toBe('dispatched')
    await h.runtime.reportUnconfirmedWorkerStart(dispatchId)
    expect(alerts()).toHaveLength(1)
  })

  it('tells the coordinator about a start a restart cut between the brief and its Enter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-unconfirmed-start-'))
    dirs.push(dir)
    h.setup({ userDataDir: dir })
    vi.spyOn(h.runtime, 'sendTerminalAgentPrompt').mockReturnValue(new Promise(() => {}))
    const task = h.db.createTask({ spec: 'cut start', runId: h.activeRunId })
    void h.call('orchestration.workerStart', { task: task.id, from: 'term_coord', agent: 'codex' })
    await vi.waitFor(() => expect(h.runtime.sendTerminalAgentPrompt).toHaveBeenCalled())
    const dispatchId = getActiveDispatchForTask(h.db, task.id)?.id ?? ''

    h.restart()
    await h.runtime.reportUnconfirmedWorkerStart(dispatchId)
    await h.runtime.reportUnconfirmedWorkerStart(dispatchId)

    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('start_unknown')
    expect(alerts()).toHaveLength(1)
  })
})
