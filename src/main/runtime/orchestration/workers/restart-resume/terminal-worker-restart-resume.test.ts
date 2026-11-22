import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { TerminalWorkerRestartResume } from './terminal-worker-restart-resume'

let db: OrchestrationDb | undefined
afterEach(() => db?.close())

function lostWorker(presence: 'working' | 'resting' | 'prompt'): string {
  db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'reboot',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: 'tab_c:leaf_c'
  })
  const task = db.createTask({ spec: 'keep working', runId: run.id })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: { topology: 'current', agent: 'codex' }
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle: 'term_lost',
    paneKey: 'tab_lost:leaf_lost',
    processIncarnation: 'pty-lost:11111111-1111-4111-8111-111111111111',
    worktreeId: 'repo::/tmp/repo',
    setupState: 'not_applicable',
    effects: [],
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(dispatch.id)
  db.db
    .prepare('UPDATE worker_terminal_resources SET resume_session = ? WHERE owner_dispatch_id = ?')
    .run(
      JSON.stringify({
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'thread-1' },
        connectionId: null
      }),
      dispatch.id
    )
  db.db
    .prepare('INSERT INTO worker_presence (dispatch_id, presence, generation) VALUES (?, ?, 1)')
    .run(dispatch.id, presence)
  return dispatch.id
}

function owner(overrides: { reopen?: () => Promise<{ handle: string } | null> } = {}) {
  const sendPrompt = vi.fn(async () => undefined)
  const resume = new TerminalWorkerRestartResume({
    getDb: () => db ?? null,
    resumeWorkOnRestart: () => true,
    reopen: overrides.reopen ?? (async () => ({ handle: 'term_resumed' })),
    terminalAuthority: () => ({
      paneKey: 'tab_new:leaf_new',
      processIncarnation: 'pty-new:22222222-2222-4222-8222-222222222222'
    }),
    handleForPane: () => 'term_resumed',
    waitForAgentIdle: async () => true,
    sendPrompt,
    setTimer: () => ({ cancel: () => {} })
  })
  return { resume, sendPrompt }
}

describe('TerminalWorkerRestartResume', () => {
  it('asks only a worker cut mid-turn to continue', async () => {
    for (const presence of ['working', 'resting', 'prompt'] as const) {
      const dispatchId = lostWorker(presence)
      const { resume, sendPrompt } = owner()
      expect(resume.holdForReopen(dispatchId, vi.fn())).toBe(true)
      resume.settleStartup()
      await vi.waitFor(() =>
        expect(db!.getDispatchContextById(dispatchId)?.assignee_handle).toBe('term_resumed')
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(sendPrompt.mock.calls.map((call) => (call as unknown[])[1])).toEqual(
        presence === 'working'
          ? [
              "Orca restarted, so your previous reply was cut off partway through. Before continuing, check whether your most recent action completed — don't repeat it if it did. Then carry on."
            ]
          : []
      )
      db!.close()
      db = undefined
    }
  })

  it('reports the worker lost once when its conversation cannot reopen', async () => {
    const dispatchId = lostWorker('working')
    const fail = vi.fn()
    const { resume } = owner({ reopen: async () => null })
    expect(resume.holdForReopen(dispatchId, fail)).toBe(true)
    // A second sweep of the same worker before it reopens is the same hold.
    expect(resume.holdForReopen(dispatchId, fail)).toBe(true)
    resume.settleStartup()
    await vi.waitFor(() => expect(fail).toHaveBeenCalledTimes(1))
    expect(resume.isHeld(dispatchId)).toBe(false)
  })

  it('never resumes a Dispatch its coordinator stopped', () => {
    const dispatchId = lostWorker('working')
    db!.db
      .prepare("UPDATE worker_dispatches SET state = 'stopping' WHERE dispatch_id = ?")
      .run(dispatchId)
    expect(owner().resume.holdForReopen(dispatchId, vi.fn())).toBe(false)
  })
})
