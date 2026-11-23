import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { TerminalWorkerRestartOffers } from '../../../../orchestration/workers/restart-resume/terminal-worker-restart-offers'
import {
  continueRestartOffers,
  dismissRestartOffers,
  listRestartOffers
} from './terminal-worker-restart-offer-rows'

let db: OrchestrationDb | undefined
afterEach(() => db?.close())

/** A real worker Dispatch, so `owned` runs the real lookup that tells it from a chat id. */
function workerDispatchId(): string {
  db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'reboot',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: 'tab_c:leaf_c'
  })
  const task = db.createTask({ spec: 'keep working', runId: run.id })
  return db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: { topology: 'current', agent: 'codex' }
  }).dispatch.id
}

const chatRow = { sessionId: 'chat-1', agent: 'claude' }

function offers() {
  const workerId = workerDispatchId()
  const workerRow = { sessionId: workerId, agent: 'claude' }
  const restartResume = {
    list: vi.fn(async () => [chatRow]),
    listFailures: vi.fn(async () => []),
    dismiss: vi.fn(async (ids?: readonly string[]) => ids?.length ?? 1),
    continueAfterRestart: vi.fn(async () => ({
      resumed: [],
      continued: [{ sessionId: 'chat-1', outcome: 'continued' as const }]
    }))
  }
  const terminalWorkerRestartOffers = new TerminalWorkerRestartOffers({
    getDb: () => db ?? null,
    resume: { resumeOffered: async () => true, forget: () => {} },
    failLost: () => {}
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows code reads only sessionId and agent.
  vi.spyOn(terminalWorkerRestartOffers, 'list').mockReturnValue([workerRow as never])
  vi.spyOn(terminalWorkerRestartOffers, 'continue').mockImplementation(async (ids) =>
    ids.map((sessionId) => ({ sessionId, outcome: 'continued' as const }))
  )
  vi.spyOn(terminalWorkerRestartOffers, 'dismiss').mockImplementation((ids) => ids.length)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these helpers read only the methods stubbed here.
  const host = { restartResume } as never
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
  const runtime = { terminalWorkerRestartOffers } as never
  return { host, runtime, restartResume, terminalWorkerRestartOffers, workerId, workerRow }
}

describe('restart offers shared by cut chats and offered terminal workers', () => {
  it('lists offered workers beside the cut chats', async () => {
    const { host, runtime, workerRow } = offers()
    await expect(listRestartOffers(runtime, host, undefined)).resolves.toEqual([chatRow, workerRow])
  })

  it('sends each named id to its own owner when resumed or dismissed', async () => {
    const { host, runtime, restartResume, terminalWorkerRestartOffers, workerId } = offers()
    const answer = await continueRestartOffers(runtime, host, ['chat-1', workerId], 'me', undefined)
    expect(restartResume.continueAfterRestart).toHaveBeenCalledWith(['chat-1'], 'me', undefined)
    expect(terminalWorkerRestartOffers.continue).toHaveBeenCalledWith([workerId])
    expect(answer.continued.map((entry) => entry.sessionId)).toEqual(['chat-1', workerId])

    await expect(dismissRestartOffers(runtime, host, [workerId], undefined)).resolves.toBe(1)
    expect(restartResume.dismiss).not.toHaveBeenCalled()
    expect(terminalWorkerRestartOffers.dismiss).toHaveBeenCalledWith([workerId])
  })

  it('dismisses every shown chat and worker when no id is named', async () => {
    const { host, runtime, restartResume, terminalWorkerRestartOffers, workerId } = offers()
    await dismissRestartOffers(runtime, host, undefined, undefined)
    expect(restartResume.dismiss).toHaveBeenCalledWith(undefined, undefined)
    expect(terminalWorkerRestartOffers.dismiss).toHaveBeenCalledWith([workerId])
  })
})
