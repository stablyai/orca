import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { TerminalWorkerRestartResume } from './terminal-worker-restart-resume'
import { TerminalWorkerRestartOffers } from './terminal-worker-restart-offers'
import { observeWorker, reconsiderRestAfterWait } from '../turn-stops/worker-presence-report'
import { resolveTerminalWorkerDispatch } from '../turn-stops/terminal-worker-turn-stops'

let db: OrchestrationDb | undefined
afterEach(() => db?.close())

/** A worker a restart took; `index` adds another to the same database. */
function lostWorker(presence: 'working' | 'resting' | 'prompt', index = 0): string {
  if (index === 0) {
    db = new OrchestrationDb(':memory:')
  }
  const d = db!
  const suffix = index === 0 ? '' : String(index)
  const run = d.createRun({
    objective: 'reboot',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: 'tab_c:leaf_c'
  })
  const task = d.createTask({ spec: 'keep working', runId: run.id })
  const { dispatch } = d.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: { topology: 'current', agent: 'codex' }
  })
  d.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle: `term_lost${suffix}`,
    paneKey: `tab_lost:leaf_lost${suffix}`,
    processIncarnation: 'pty-lost:11111111-1111-4111-8111-111111111111',
    worktreeId: 'repo::/tmp/repo',
    setupState: 'not_applicable',
    effects: [],
    terminalOwnership: 'created'
  })
  d.markWorkerDispatchReady(dispatch.id)
  d.db
    .prepare('UPDATE worker_terminal_resources SET resume_session = ? WHERE owner_dispatch_id = ?')
    .run(
      JSON.stringify({
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'thread-1' },
        connectionId: null
      }),
      dispatch.id
    )
  d.db
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
    decideHeldRest?: (dispatchId: string) => void
    offersChanged?: () => void
    resumeWorkOnRestart?: boolean | (() => boolean)
    paneConversation?: 'own' | 'other' | 'unknown'
    paneSessions?: () => string[]
    setTimer?: (run: () => void, delayMs: number) => { cancel: () => void }
  } = {}
) {
  const sendPrompt = vi.fn(overrides.sendPrompt ?? (async () => true))
  const resume = new TerminalWorkerRestartResume({
    getDb: () => db ?? null,
    resumeWorkOnRestart: () =>
      typeof overrides.resumeWorkOnRestart === 'function'
        ? overrides.resumeWorkOnRestart()
        : (overrides.resumeWorkOnRestart ?? true),
    reopen: overrides.reopen ?? (async () => ({ handle: 'term_resumed' })),
    closeTerminal: overrides.closeTerminal ?? (async () => undefined),
    reportResting: overrides.reportResting ?? (async () => undefined),
    decideHeldRest: overrides.decideHeldRest ?? (() => {}),
    offersChanged: overrides.offersChanged ?? (() => {}),
    terminalAuthority: () => ({
      paneKey: 'tab_new:leaf_new',
      processIncarnation: 'pty-new:22222222-2222-4222-8222-222222222222'
    }),
    handleForPane: overrides.handleForPane ?? (() => 'term_resumed'),
    paneConversation: () => overrides.paneConversation ?? 'unknown',
    paneSessions: overrides.paneSessions ?? (() => []),
    waitForAgentReady: overrides.waitForAgentReady ?? (async () => true),
    sendPrompt,
    setTimer: overrides.setTimer ?? (() => ({ cancel: () => {} }))
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

  it('tells the coordinator a resumed worker rests when a wait its lost terminal ran held the report back', async () => {
    const dispatchId = lostWorker('working')
    const reportDeps = { getDb: () => db!, isWaitingForMail: () => false, notify: vi.fn() }
    // It rested while waiting for mail, so its report was held for that wait; the reboot ended it.
    observeWorker(
      db!,
      { kind: 'local', dispatch: db!.getDispatchContextById(dispatchId)! },
      {
        presence: 'at-rest',
        fence: 'turn:turn-1',
        legacyStopKey: 'turn:turn-1',
        rest: { from: 'term_lost', reason: 'needs-input', lastOutput: undefined }
      },
      { ...reportDeps, isWaitingForMail: () => true }
    )
    const escalations = () =>
      db!.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE type = 'escalation'").get()
    expect(escalations()).toEqual({ n: 0 })
    const { resume } = owner({
      decideHeldRest: (id) => reconsiderRestAfterWait(`dispatch:${id}`, reportDeps)
    })
    resume.holdForReopen(dispatchId, vi.fn())
    resume.settleStartup()
    await vi.waitFor(() => expect(escalations()).toEqual({ n: 1 }))
  })

  it('with Resume work on restart off, offers the worker and starts nothing until a person acts', () => {
    const dispatchId = lostWorker('working')
    const reopen = vi.fn(async () => ({ handle: 'term_resumed' }))
    const offersChanged = vi.fn()
    const { resume } = owner({ reopen, offersChanged, resumeWorkOnRestart: false })
    expect(resume.holdForReopen(dispatchId, vi.fn())).toBe(true)
    resume.settleStartup()
    expect(reopen).not.toHaveBeenCalled()
    expect(offersChanged).toHaveBeenCalledTimes(1)
    // The restart's own stop report stays silent about it, as about a chat whose cut waits on a person.
    expect(resume.isResumingThisStart(dispatchId)).toBe(true)
  })

  it('resumes an offered pane that has not shown its agent once it does, asking a cut turn to go on', async () => {
    const dispatchId = lostWorker('working')
    const offersChanged = vi.fn()
    const { resume, sendPrompt } = owner({ offersChanged, resumeWorkOnRestart: false })
    expect(resume.holdInPlace(dispatchId, 'tab_lost:leaf_lost', 'pty-lost:old', vi.fn())).toBe(true)
    // The person chose Resume before the window brought the conversation back in its pane: the
    // answer waits for the agent, so the toast never says resumed before it is.
    let answered: boolean | undefined
    void resume.resumeOffered(dispatchId, vi.fn()).then((resumed) => (answered = resumed))
    expect(db!.getWorkerDispatch(dispatchId)?.stage).toBe('restart_resumed')
    // Resume pressed again, as from a second window: the same answer, once it is known.
    let repeated: boolean | undefined
    void resume.resumeOffered(dispatchId, vi.fn()).then((resumed) => (repeated = resumed))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(answered).toBeUndefined()
    expect(repeated).toBeUndefined()
    resume.observePaneAgents([{ paneKey: 'tab_lost:leaf_lost', sessionId: 'thread-1' }])
    await vi.waitFor(() => expect(answered).toBe(true))
    expect(repeated).toBe(true)
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1))
    expect(db!.getDispatchContextById(dispatchId)?.assignee_handle).toBe('term_resumed')
  })

  it("keeps an offered worker's own turn stops from its coordinator until a person acts", () => {
    const dispatchId = lostWorker('resting')
    const turnStops = {
      getDb: () => db!,
      getHandle: () => 'term_lost',
      getProcessIncarnation: () => null
    }
    expect(resolveTerminalWorkerDispatch(turnStops, 'tab_lost:leaf_lost')).not.toBeNull()
    owner({ resumeWorkOnRestart: false }).resume.holdForReopen(dispatchId, vi.fn())
    expect(resolveTerminalWorkerDispatch(turnStops, 'tab_lost:leaf_lost')).toBeNull()
  })

  for (const inPane of ['unknown', 'other'] as const) {
    it(`resumes an offered worker bound in place ${inPane === 'unknown' ? 'in its pane' : 'elsewhere once another agent took its pane'}`, async () => {
      const dispatchId = lostWorker('working')
      const reopen = vi.fn(async () => ({ handle: 'term_reopened' }))
      const { resume, sendPrompt } = owner({
        reopen,
        resumeWorkOnRestart: false,
        paneConversation: inPane
      })
      resume.holdInPlace(dispatchId, 'tab_lost:leaf_lost', 'pty-lost:old', vi.fn())
      resume.observePaneAgents([{ paneKey: 'tab_lost:leaf_lost', sessionId: 'thread-1' }])
      await vi.waitFor(() =>
        expect(db!.getDispatchContextById(dispatchId)?.assignee_handle).toBe('term_resumed')
      )
      // Its resting agent has not had a live turn since the restart: its pane is still its own.
      await resume.resumeOffered(dispatchId, vi.fn())
      expect(reopen).toHaveBeenCalledTimes(inPane === 'unknown' ? 0 : 1)
      if (inPane === 'unknown') {
        await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1))
      }
    })
  }

  it('does not raise an offer again that a person was already shown', () => {
    const dispatchId = lostWorker('resting')
    const offersChanged = vi.fn()
    const { resume } = owner({ offersChanged, resumeWorkOnRestart: false })
    expect(resume.holdForReopen(dispatchId, vi.fn())).toBe(true)
    // A later sweep in the same run, or the next start, finds it offered already.
    expect(resume.holdForReopen(dispatchId, vi.fn())).toBe(true)
    db!.db
      .prepare(
        "UPDATE worker_dispatches SET updated_at = '2026-01-01 00:00:00' WHERE dispatch_id = ?"
      )
      .run(dispatchId)
    const next = owner({ offersChanged, resumeWorkOnRestart: false }).resume
    expect(next.holdInPlace(dispatchId, 'tab_lost:leaf_lost', 'pty-lost:old', vi.fn())).toBe(true)
    expect(offersChanged).toHaveBeenCalledTimes(1)
    // Its age in the toast stays the time it was first offered.
    expect(db!.getWorkerDispatch(dispatchId)?.updated_at).toBe('2026-01-01 00:00:00')
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

  it('starts nothing for a held Dispatch its coordinator stops before startup settles', async () => {
    const dispatchId = lostWorker('working')
    const reopen = vi.fn(async () => ({ handle: 'term_resumed' }))
    const { resume } = owner({ reopen })
    const fail = vi.fn()
    expect(resume.holdForReopen(dispatchId, fail)).toBe(true)
    db!.db
      .prepare("UPDATE worker_dispatches SET state = 'stopping' WHERE dispatch_id = ?")
      .run(dispatchId)
    resume.settleStartup()
    // Today's outcome settles the stop for a terminal that is gone.
    await vi.waitFor(() => expect(fail).toHaveBeenCalledTimes(1))
    expect(reopen).not.toHaveBeenCalled()
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

  it('keeps a worker offered while the setting was off waiting on a person once it is turned on', async () => {
    const reboot = lostWorker('working')
    const crash = lostWorker('working', 1)
    let setting = false
    const reopen = vi.fn(async () => ({ handle: 'term_reopened' }))
    const { resume, sendPrompt } = owner({ reopen, resumeWorkOnRestart: () => setting })
    resume.holdForReopen(reboot, vi.fn())
    resume.holdForReopen(crash, vi.fn())
    setting = true
    // Later sweeps in the same run find both offered, one reopening and one starting again in place.
    expect(resume.holdForReopen(reboot, vi.fn())).toBe(true)
    resume.settleStartup()
    expect(resume.holdInPlace(crash, 'tab_lost:leaf_lost1', 'pty-lost:old', vi.fn())).toBe(true)
    resume.observePaneAgents([{ paneKey: 'tab_lost:leaf_lost1', sessionId: 'thread-1' }])
    await vi.waitFor(() =>
      expect(db!.getDispatchContextById(crash)?.assignee_handle).toBe('term_resumed')
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reopen).not.toHaveBeenCalled()
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(db!.getWorkerDispatch(reboot)?.stage).toBe('restart_offered')
    expect(db!.getWorkerDispatch(crash)?.stage).toBe('restart_offered')
  })

  it('binds a pane whose agent reported its conversation before its new process registered', async () => {
    const dispatchId = lostWorker('resting')
    let reported: string[] = []
    const { resume } = owner({ paneSessions: () => reported })
    resume.holdInPlace(dispatchId, 'tab_lost:leaf_lost', 'pty-lost:old', vi.fn())
    // Its hook named the conversation once; only the new process registering is left to see.
    reported = ['thread-1']
    resume.recheckHeldPanes()
    await vi.waitFor(() =>
      expect(db!.getDispatchContextById(dispatchId)?.assignee_handle).toBe('term_resumed')
    )
    // An agent that reported before the hold began is bound by the hold itself.
    const early = lostWorker('resting', 1)
    expect(resume.holdInPlace(early, 'tab_lost:leaf_lost1', 'pty-lost:old', vi.fn())).toBe(true)
    await vi.waitFor(() => expect(resume.isHeld(early)).toBe(false))
    expect(db!.getDispatchContextById(early)?.assignee_handle).toBe('term_resumed')
  })

  it('reopens the conversations a restart took three at a time', async () => {
    const ids = [0, 1, 2, 3].map((index) => lostWorker('resting', index))
    const answers: ((terminal: null) => void)[] = []
    const reopen = vi.fn(() => new Promise<null>((resolve) => answers.push(resolve)))
    const { resume } = owner({ reopen })
    for (const dispatchId of ids) {
      resume.holdForReopen(dispatchId, vi.fn())
    }
    resume.settleStartup()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reopen).toHaveBeenCalledTimes(3)
    answers[0]!(null)
    await vi.waitFor(() => expect(reopen).toHaveBeenCalledTimes(4))
  })

  it('answers a repeat Resume with the first one’s outcome while its conversation reopens', async () => {
    const dispatchId = lostWorker('resting')
    let answer: (terminal: null) => void = () => {}
    const reopen = vi.fn(() => new Promise<null>((resolve) => (answer = resolve)))
    const { resume } = owner({ reopen, resumeWorkOnRestart: false })
    resume.holdForReopen(dispatchId, vi.fn())
    const first = resume.resumeOffered(dispatchId, vi.fn())
    const repeated = resume.resumeOffered(dispatchId, vi.fn())
    await vi.waitFor(() => expect(reopen).toHaveBeenCalledTimes(1))
    answer(null)
    expect(await first).toBe(false)
    expect(await repeated).toBe(false)
  })

  it('never binds a worker a person dismissed while its pane was starting again', async () => {
    const dispatchId = lostWorker('working')
    const { resume } = owner({ resumeWorkOnRestart: false })
    const offers = new TerminalWorkerRestartOffers({ getDb: () => db!, resume, failLost: vi.fn() })
    resume.holdInPlace(dispatchId, 'tab_lost:leaf_lost', 'pty-lost:old', vi.fn())
    expect(offers.dismiss([dispatchId])).toBe(1)
    resume.observePaneAgents([{ paneKey: 'tab_lost:leaf_lost', sessionId: 'thread-1' }])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(db!.getDispatchContextById(dispatchId)?.assignee_handle).toBe('term_lost')
  })

  it('asks a worker resumed in place to continue once its agent comes up', async () => {
    const dispatchId = lostWorker('working')
    const waitForAgentReady = vi.fn<() => Promise<boolean>>()
    waitForAgentReady.mockResolvedValueOnce(false).mockResolvedValue(true)
    const { resume, sendPrompt } = owner({
      waitForAgentReady,
      setTimer: (run, delayMs) => {
        const timer = setTimeout(run, delayMs)
        return { cancel: () => clearTimeout(timer) }
      }
    })
    resume.holdInPlace(dispatchId, 'tab_lost:leaf_lost', 'pty-lost:old', vi.fn())
    resume.observePaneAgents([{ paneKey: 'tab_lost:leaf_lost', sessionId: 'thread-1' }])
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1), { timeout: 5_000 })
    expect(waitForAgentReady).toHaveBeenCalledTimes(2)
  })
})
