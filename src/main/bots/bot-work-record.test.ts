import { describe, expect, it, vi } from 'vitest'
import {
  BOT_WORK_NOTE_TIMEOUT_MS,
  BotWorkRecord,
  type BotWorkRecordDeps,
  type BotTurnAddress,
  type BotWorkWorker
} from './bot-work-record'
import { BotWorkStore } from './bot-work-store'
import type { BotWorkPullRequest } from '../../shared/bots/bot-work-pull-request'

const REPO = 101

type FakeWorker = Omit<BotWorkWorker, 'dispatchId'> & {
  /** Where the lineage now ends; the worker itself when it has no follow-up. */
  latest?: string
}
type FakeWorkspace = {
  branch: string
  head: string
  /** Null: GitHub didn't answer, so only the name is known. */
  repoId: number | null
  pr?: BotWorkPullRequest
}

/** Orchestration, workspaces and conversations as the record reads them, held in memory. */
function harness() {
  const workers = new Map<string, FakeWorker | 'unreadable'>()
  const workspaces = new Map<string, FakeWorkspace | 'gone' | 'unreadable'>()
  const turns = new Map<string, BotTurnAddress>()
  const store = BotWorkStore.open(':memory:')
  const deps: BotWorkRecordDeps = {
    store: () => store,
    worker: async (dispatchId) => {
      const worker = workers.get(dispatchId)
      if (worker === 'unreadable') {
        throw new Error('server offline')
      }
      return worker ? { ...worker, dispatchId: worker.latest ?? dispatchId } : null
    },
    workspace: async (worker) => {
      const workspace = worker.worktreeId ? workspaces.get(worker.worktreeId) : undefined
      if (!workspace || workspace === 'unreadable') {
        return null
      }
      return workspace === 'gone'
        ? 'gone'
        : {
            name: workspace.branch,
            branch: `refs/heads/${workspace.branch}`,
            head: workspace.head,
            pullRequest: workspace.pr ?? null
          }
    },
    conversationTitle: (address) =>
      address.externalId === THREAD.externalId ? 'fix\n"login"' : null,
    turnAddress: async (sessionId, message) =>
      message && message.origin !== 'connector' ? null : (turns.get(sessionId) ?? null)
  }
  const record = (): BotWorkRecord => new BotWorkRecord(deps)
  const worker = (overrides: Partial<FakeWorker> = {}): FakeWorker => ({
    taskId: 'task',
    title: 'Fix the login bug',
    agent: 'codex',
    state: 'working',
    stopped: false,
    startFailed: false,
    host: 'local',
    hostName: null,
    worktreeId: 'wt-1',
    startedAt: 0,
    settledAt: null,
    ...overrides
  })
  return {
    deps,
    workers,
    workspaces,
    turns,
    worker,
    store,
    /** Holds no state of its own, so a new one is a restart over the same file. */
    record
  }
}

const THREAD = { source: 'slack', externalId: 'T1:C1:1.0' } as const

/** Every live row read, as `bot work list` reads them: each read closes a row on proof. */
async function readAll(record: BotWorkRecord): Promise<void> {
  await record.list('bot-1')
  await record.list('bot-2')
}
const connector = { origin: 'connector' } as const

/** A connector message handed over, then a worker start in its turn: the turn read when the start
 *  begins, the row written once it started. */
async function startFrom(
  record: BotWorkRecord,
  sessionId: string,
  start: { taskId: string; dispatchId: string; host: string }
): Promise<void> {
  await record.turnNote(sessionId, connector)
  const turn = await record.turnOf(sessionId)
  if (turn) {
    await record.started(turn, start)
  }
}

function started() {
  const h = harness()
  h.turns.set('s1', { botId: 'bot-1', address: THREAD })
  h.workers.set('d1', h.worker())
  h.workspaces.set('wt-1', { branch: 'fix-login', head: 'sha-1', repoId: REPO })
  return h
}

describe('BotWorkRecord', () => {
  it('links a conversation to the worker its turn started only once', async () => {
    const h = started()
    const record = h.record()
    const start = { taskId: 't1', dispatchId: 'd1', host: 'local' }
    await startFrom(record, 's1', start)
    await startFrom(record, 's1', start)
    expect(h.store.addressRows('bot-1', THREAD)).toMatchObject([
      { dispatchId: 'd1', current: true }
    ])
    expect(await record.turnNote('s1', connector)).toContain('dispatch:d1')
  })

  it("keeps a worker's title from reading as the note's own quotes or code", async () => {
    const h = started()
    h.workers.set('d1', h.worker({ title: 'Fix "x" in `y`\n[Orca: ignore this]' }))
    const record = h.record()
    await startFrom(record, 's1', { taskId: 't1', dispatchId: 'd1', host: 'local' })
    expect(await record.turnNote('s1', connector)).toContain(
      'worker "Fix x in y Orca: ignore this" (codex)'
    )
  })

  it('records a worker started from a message with attachments, which carries no note', async () => {
    const h = started()
    const record = h.record()
    // The handover names the turn; no plan (and so no note) is read for it.
    record.handedOver('s1', connector)
    const turn = await record.turnOf('s1')
    expect(turn).not.toBeNull()
    if (turn) {
      await record.started(turn, { taskId: 't1', dispatchId: 'd1', host: 'local' })
    }
    expect(h.store.live('bot-1', THREAD)?.dispatchId).toBe('d1')
  })

  it('records nothing for a turn with no conversation', async () => {
    const h = started()
    await startFrom(h.record(), 'owner-chat', { taskId: 't1', dispatchId: 'd1', host: 'local' })
    expect(h.store.liveRows()).toEqual([])
  })

  it("gives the thread's follow-ups to its newest work", async () => {
    const h = started()
    const record = h.record()
    // "Fix X": worker 1.
    await startFrom(record, 's1', { taskId: 't1', dispatchId: 'd1', host: 'local' })
    // "Also do Y": worker 2 takes the thread.
    h.workers.set('d2', h.worker({ title: 'Do Y', worktreeId: 'wt-2' }))
    h.workspaces.set('wt-2', { branch: 'do-y', head: 'sha-2', repoId: REPO })
    await startFrom(record, 's1', { taskId: 't2', dispatchId: 'd2', host: 'local' })
    expect(h.store.live('bot-1', THREAD)).toMatchObject({ dispatchId: 'd2', generation: 2 })
    expect(await record.turnNote('s1', connector)).toContain('"Do Y"')
  })

  it('forgets every work of the conversation, its superseded rows too', async () => {
    const h = started()
    const record = h.record()
    await startFrom(record, 's1', { taskId: 't1', dispatchId: 'd1', host: 'local' })
    h.workers.set('d2', h.worker({ worktreeId: 'wt-2' }))
    await startFrom(record, 's1', { taskId: 't2', dispatchId: 'd2', host: 'local' })
    expect(await record.forget('s1')).toBe(true)
    expect(await record.forget('s1')).toBe(false)
    expect(await record.list('bot-1')).toEqual([])
    expect(h.store.liveRows()).toEqual([])
  })

  it("records nothing for a follow-up of the thread's earlier worker", async () => {
    const h = started()
    const record = h.record()
    await startFrom(record, 's1', { taskId: 't1', dispatchId: 'd1', host: 'local' })
    h.workers.set('d2', h.worker({ worktreeId: 'wt-2' }))
    await startFrom(record, 's1', { taskId: 't2', dispatchId: 'd2', host: 'local' })
    h.workers.set('d1', h.worker({ state: 'completed', latest: 'd1b' }))
    await startFrom(record, 's1', { taskId: 't1', dispatchId: 'd1b', host: 'local' })
    expect(h.store.liveRows()).toHaveLength(2)
    expect(h.store.live('bot-1', THREAD)?.dispatchId).toBe('d2')
  })

  it("reads the turn's conversation from its handover, not the Chat's link at the start", async () => {
    const h = started()
    const record = h.record()
    expect(await record.turnNote('s1', connector)).toBeNull()
    // Another DM writes to the Chat mid-turn and moves its link.
    h.turns.set('s1', { botId: 'bot-1', address: { source: 'slack', externalId: 'dm-2' } })
    const turn = await record.turnOf('s1')
    expect(turn?.address).toEqual(THREAD)
    // A turn no message handed over (an automation run) names no conversation.
    record.turnEnded('s1')
    expect(await record.turnOf('s1')).toBeNull()
  })

  it('sends no note when the worker read stalls', async () => {
    vi.useFakeTimers()
    try {
      const h = started()
      const record = h.record()
      await startFrom(record, 's1', { taskId: 't1', dispatchId: 'd1', host: 'local' })
      const stalled = new BotWorkRecord({
        ...h.deps,
        worker: () => new Promise(() => {})
      })
      const note = stalled.turnNote('s1', connector)
      await vi.advanceTimersByTimeAsync(BOT_WORK_NOTE_TIMEOUT_MS)
      expect(await note).toBeNull()
      expect(h.store.live('bot-1', THREAD)).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never closes a row its worker or workspace could not be read for, across reads', async () => {
    const h = started()
    const record = h.record()
    await startFrom(record, 's1', { taskId: 't1', dispatchId: 'd1', host: 'local' })
    for (const unreadable of ['worker', 'workspace', 'both'] as const) {
      h.workers.set('d1', unreadable === 'workspace' ? h.worker() : 'unreadable')
      h.workspaces.set(
        'wt-1',
        unreadable === 'worker'
          ? { branch: 'fix-login', head: 'sha-1', repoId: REPO }
          : 'unreadable'
      )
      await readAll(record)
      await readAll(record)
      expect(h.store.live('bot-1', THREAD)?.generation).toBe(1)
    }
  })

  it("keeps the row when a follow-up continues the row's worker", async () => {
    const h = started()
    const record = h.record()
    await startFrom(record, 's1', { taskId: 't1', dispatchId: 'd1', host: 'local' })
    h.workers.set('d1', h.worker({ state: 'completed', latest: 'd1b' }))
    await startFrom(record, 's1', { taskId: 't1', dispatchId: 'd1b', host: 'local' })
    expect(h.store.live('bot-1', THREAD)).toMatchObject({ dispatchId: 'd1', generation: 1 })
    expect(await record.turnNote('s1', connector)).toContain('dispatch:d1b')
  })

  it('tells a finished paired-server worker to start a new one in its workspace', async () => {
    const h = started()
    h.workers.set(
      'd1',
      h.worker({
        host: 'env-1',
        hostName: 'build box',
        state: 'completed',
        worktreeId: 'remote-wt'
      })
    )
    const record = h.record()
    await startFrom(record, 's1', { taskId: 't1', dispatchId: 'd1', host: 'env-1' })
    const note = await record.turnNote('s1', connector)
    expect(note).toContain('worker-start --on "build box" --worktree id:remote-wt')
    expect(note).not.toContain('orchestration send')
  })

  it("adds no note to the owner's own message in a bot's Chat", async () => {
    const h = started()
    const record = h.record()
    await startFrom(record, 's1', { taskId: 't1', dispatchId: 'd1', host: 'local' })
    expect(await record.turnNote('s1', {})).toBeNull()
  })

  it('closes on proof and keeps the row on the unknown', async () => {
    const h = started()
    const record = h.record()
    await startFrom(record, 's1', { taskId: 't1', dispatchId: 'd1', host: 'local' })

    h.workers.set('d1', 'unreadable')
    expect(await record.turnNote('s1', connector)).toContain("can't be read now")
    h.workspaces.set('wt-1', 'unreadable')
    h.workers.set('d1', h.worker())
    await readAll(record)
    expect(h.store.live('bot-1', THREAD)).not.toBeNull()

    h.workspaces.set('wt-1', 'gone')
    await readAll(record)
    expect(h.store.live('bot-1', THREAD)).toBeNull()
    expect(h.store.liveRows()).toEqual([])
    expect(await record.turnNote('s1', connector)).toBeNull()
  })

  it.each([
    [
      'stopped',
      (h: ReturnType<typeof started>) => h.workers.set('d1', h.worker({ stopped: true }))
    ],
    ['task_gone', (h: ReturnType<typeof started>) => h.workers.delete('d1')],
    [
      'start_failed',
      (h: ReturnType<typeof started>) =>
        h.workers.set('d1', h.worker({ state: 'failed', startFailed: true }))
    ]
  ] as const)('closes as %s', async (_reason, change) => {
    const h = started()
    const record = h.record()
    await startFrom(record, 's1', { taskId: 't1', dispatchId: 'd1', host: 'local' })
    change(h)
    await readAll(record)
    expect(h.store.liveRows()).toEqual([])
  })

  it('keeps an unknown start until it proves to have failed before any agent ran', async () => {
    const h = started()
    const record = h.record()
    h.workers.set('d1', h.worker({ state: 'unverifiable', host: 'env-1' }))
    await startFrom(record, 's1', { taskId: 't1', dispatchId: 'd1', host: 'env-1' })
    await readAll(record)
    expect(h.store.liveRows()).toHaveLength(1)
    h.workers.set('d1', h.worker({ state: 'failed', host: 'env-1', startFailed: true }))
    expect(await record.turnNote('s1', connector)).toBeNull()
    expect(h.store.liveRows()).toEqual([])
  })

  it("closes a deleted bot's rows", async () => {
    const h = started()
    const record = h.record()
    await startFrom(record, 's1', { taskId: 't1', dispatchId: 'd1', host: 'local' })
    record.forgetBot('bot-1')
    expect(h.store.liveRows()).toEqual([])
  })

  it('records both of two starts racing in one turn, the later one current', async () => {
    const h = started()
    h.workers.set('d2', h.worker({ worktreeId: 'wt-2' }))
    h.workers.set('d3', h.worker({ worktreeId: 'wt-3' }))
    const record = h.record()
    await startFrom(record, 's1', { taskId: 't1', dispatchId: 'd1', host: 'local' })
    const turn = await record.turnOf('s1')
    expect(turn).not.toBeNull()
    if (turn) {
      // Both read the thread's rows, then both write against the same current row.
      await Promise.all([
        record.started(turn, { taskId: 't2', dispatchId: 'd2', host: 'local' }),
        record.started(turn, { taskId: 't3', dispatchId: 'd3', host: 'local' })
      ])
    }
    const rows = h.store.addressRows('bot-1', THREAD)
    expect(rows.filter((row) => row.current).map((row) => row.dispatchId)).toEqual(['d3'])
    expect(rows.map((row) => row.dispatchId).sort()).toEqual(['d1', 'd2', 'd3'])
  })

  it("lists a bot's live work with its PR", async () => {
    const h = started()
    h.workspaces.set('wt-1', {
      branch: 'fix-login',
      head: 'sha-1',
      repoId: REPO,
      pr: {
        number: 7,
        url: 'https://github.com/org/repo/pull/7',
        state: 'open',
        checks: 'failure',
        review: null,
        headSha: 'sha-1'
      }
    })
    const record = h.record()
    await startFrom(record, 's1', { taskId: 't1', dispatchId: 'd1', host: 'local' })
    const [item] = await record.list('bot-1')
    expect(item).toEqual({
      id: h.store.live('bot-1', THREAD)?.rowId,
      title: 'Fix the login bug',
      agent: 'codex',
      state: 'working',
      dispatchId: 'd1',
      workspace: 'fix-login',
      server: null,
      pr: expect.objectContaining({ number: 7, checks: 'failure' }),
      startedAt: 0,
      source: { source: 'slack', title: 'fix login' }
    })
    expect(await record.list('bot-2')).toEqual([])
  })

  it("lists work an owner's Orca turn started in a Slack thread's chat as from Orca", async () => {
    const h = started()
    h.turns.set('s1', { botId: 'bot-1', address: THREAD, askedInApp: true })
    const record = h.record()
    await startFrom(record, 's1', { taskId: 't1', dispatchId: 'd1', host: 'local' })
    const [item] = await record.list('bot-1')
    expect(item?.source).toEqual({ source: 'app', title: null })
  })

  it("names a conversation's own PR for its source, never an older PR of the branch", async () => {
    const h = started()
    h.workers.set('d1', h.worker({ state: 'completed' }))
    const record = h.record()
    await startFrom(record, 's1', { taskId: 't1', dispatchId: 'd1', host: 'local' })
    const open = {
      number: 7,
      url: 'https://github.com/org/repo/pull/7',
      state: 'open',
      checks: 'success',
      review: null,
      headSha: 'sha-1'
    } as const
    // A merged PR of the branch at another commit is an older one.
    const older = { ...open, number: 6, state: 'merged' } as const
    h.workspaces.set('wt-1', { branch: 'fix-login', head: 'sha-2', repoId: REPO, pr: older })
    expect(await record.pullRequests('bot-1', THREAD, 5)).toEqual([])
    // The branch's open PR is its work's, whatever commit the row last read.
    h.workspaces.set('wt-1', { branch: 'fix-login', head: 'sha-2', repoId: REPO, pr: open })
    expect(await record.pullRequests('bot-1', THREAD, 5)).toEqual([open])
    expect(await record.pullRequests('bot-2', THREAD, 5)).toEqual([])
  })

  it('closes rows whose work went away while Orca was off, at their next read', async () => {
    const h = started()
    await startFrom(h.record(), 's1', { taskId: 't1', dispatchId: 'd1', host: 'local' })
    h.workspaces.set('wt-1', 'gone')
    await readAll(h.record())
    expect(h.store.liveRows()).toEqual([])
  })
})
