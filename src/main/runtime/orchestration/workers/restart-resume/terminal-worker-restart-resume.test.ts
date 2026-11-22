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

function owner(
  overrides: {
    reopen?: () => Promise<{ handle: string } | null>
    handleForPane?: () => string
    sendPrompt?: () => Promise<boolean>
    reportResting?: () => Promise<void>
    waitForAgentReady?: () => Promise<boolean>
    closeTerminal?: () => Promise<undefined>
  } = {}
) {
  const sendPrompt = vi.fn(overrides.sendPrompt ?? (async () => true))
  const resume = new TerminalWorkerRestartResume({
    getDb: () => db ?? null,
    resumeWorkOnRestart: () => true,
    reopen: overrides.reopen ?? (async () => ({ handle: 'term_resumed' })),
    closeTerminal: overrides.closeTerminal ?? (async () => undefined),
    reportResting: overrides.reportResting ?? (async () => undefined),
    terminalAuthority: () => ({
      paneKey: 'tab_new:leaf_new',
      processIncarnation: 'pty-new:22222222-2222-4222-8222-222222222222'
    }),
    handleForPane: overrides.handleForPane ?? (() => 'term_resumed'),
    waitForAgentReady: overrides.waitForAgentReady ?? (async () => true),
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
      expect(sendPrompt).toHaveBeenCalledTimes(presence === 'working' ? 1 : 0)
      db!.close()
      db = undefined
    }
  })

  it('tells the coordinator a resumed worker rests when it did not take its continue prompt', async () => {
    const dispatchId = lostWorker('working')
    const reportResting = vi.fn(async () => undefined)
    const { resume, sendPrompt } = owner({ sendPrompt: async () => false, reportResting })
    resume.holdForReopen(dispatchId, vi.fn())
    resume.settleStartup()
    await vi.waitFor(() => expect(reportResting).toHaveBeenCalledWith('tab_new:leaf_new'))
    expect(sendPrompt).toHaveBeenCalledTimes(1)
  })

  it('does not ask a resumed worker to continue once its coordinator stopped it', async () => {
    const dispatchId = lostWorker('working')
    let stop = (): void => {}
    const { resume, sendPrompt } = owner({
      waitForAgentReady: () =>
        new Promise((resolve) => {
          stop = () => {
            db!.db
              .prepare("UPDATE worker_dispatches SET state = 'stopping' WHERE dispatch_id = ?")
              .run(dispatchId)
            resolve(true)
          }
        })
    })
    resume.holdInPlace(dispatchId, 'tab_lost:leaf_lost', 'pty-lost:old', vi.fn())
    resume.observePaneAgents([{ paneKey: 'tab_lost:leaf_lost', sessionId: 'thread-1' }])
    await vi.waitFor(() =>
      expect(db!.getDispatchContextById(dispatchId)?.assignee_handle).toBe('term_resumed')
    )
    stop()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sendPrompt).not.toHaveBeenCalled()
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

  it('reports the worker lost when its conversation reopens as a bare shell', async () => {
    const dispatchId = lostWorker('resting')
    const fail = vi.fn()
    const closeTerminal = vi.fn(async () => undefined)
    const { resume } = owner({ waitForAgentReady: async () => false, closeTerminal })
    resume.holdForReopen(dispatchId, fail)
    resume.settleStartup()
    await vi.waitFor(() => expect(fail).toHaveBeenCalledTimes(1))
    expect(closeTerminal).toHaveBeenCalledWith('term_resumed')
    expect(db!.getDispatchContextById(dispatchId)?.assignee_handle).toBe('term_lost')
  })

  it('starts nothing for a held Dispatch its coordinator stops before startup settles', () => {
    const dispatchId = lostWorker('working')
    const reopen = vi.fn(async () => ({ handle: 'term_resumed' }))
    const { resume } = owner({ reopen })
    const fail = vi.fn()
    expect(resume.holdForReopen(dispatchId, fail)).toBe(true)
    db!.db
      .prepare("UPDATE worker_dispatches SET state = 'stopping' WHERE dispatch_id = ?")
      .run(dispatchId)
    resume.settleStartup()
    expect(reopen).not.toHaveBeenCalled()
    // Today's outcome settles the stop for a terminal that is gone.
    expect(fail).toHaveBeenCalledTimes(1)
  })

  it('never resumes a Dispatch its coordinator stopped', () => {
    const dispatchId = lostWorker('working')
    db!.db
      .prepare("UPDATE worker_dispatches SET state = 'stopping' WHERE dispatch_id = ?")
      .run(dispatchId)
    expect(owner().resume.holdForReopen(dispatchId, vi.fn())).toBe(false)
  })

  it('binds a pane started again in place only to the worker’s own conversation', async () => {
    const dispatchId = lostWorker('resting')
    const reopen = vi.fn(async () => ({ handle: 'term_reopened' }))
    const { resume } = owner({ reopen })
    expect(resume.holdInPlace(dispatchId, 'tab_lost:leaf_lost', 'pty-lost:old', vi.fn())).toBe(true)
    // A later recovery pass must not open the conversation a second time beside the pane.
    resume.settleStartup()
    expect(resume.holdForReopen(dispatchId, vi.fn())).toBe(true)
    resume.observePaneAgents([{ paneKey: 'tab_lost:leaf_lost', sessionId: 'another-agent' }])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(db!.getDispatchContextById(dispatchId)?.assignee_handle).toBe('term_lost')
    resume.observePaneAgents([{ paneKey: 'tab_lost:leaf_lost', sessionId: 'thread-1' }])
    await vi.waitFor(() =>
      expect(db!.getDispatchContextById(dispatchId)?.assignee_handle).toBe('term_resumed')
    )
    expect(reopen).not.toHaveBeenCalled()
  })
})
