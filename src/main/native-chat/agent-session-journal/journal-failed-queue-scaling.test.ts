import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
import {
  agentSessionJournalProviderHandle,
  codexProviderHandle
} from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { readQueuePublication } from '../agent-session-wire/structured-agent-session-queued-publication'
import { StructuredAgentSessionCurrentWork } from '../agent-session-wire/structured-agent-session-current-work'
import { journalInputOrder } from './journal-input-order'
import { isolateJournalTransition } from './journal-reducer-transition'
import { failedQueueTurnSequence } from './queued-message-pause'
import type { JournalRow } from './journal-row-schema'
import { JournalNewestTurn } from './journal-newest-turn'
import { structuredAgentSessionCommandTurn } from '../../../shared/agent-session/view/structured-agent-session-command-turn-identity'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'

function usageLimit(turnItemId: string) {
  return {
    kind: 'item' as const,
    itemId: `limit:${turnItemId}`,
    revision: 1,
    body: {
      kind: 'status' as const,
      tone: 'error' as const,
      ...agentSessionFailureWords(agentSessionFailureFact('usageLimitReached'), { surface: 'row' })
    },
    turnScope: { kind: 'turn' as const, turnItemId }
  }
}

/** Live failure position next to what a restore over the same items would derive. */
function failureFold() {
  const state = createJournalReducerState('session', 'epoch')
  const revisions = new Map<string, number>()
  const apply = (
    row: Omit<
      Extract<JournalRow, { kind: 'item' }>,
      'v' | 'epoch' | 'seq' | 'ts' | 'fence' | 'revision'
    >
  ) => {
    const revision = (revisions.get(row.itemId) ?? 0) + 1
    revisions.set(row.itemId, revision)
    const seq = state.lastSequence + 1
    applyJournalRow(state, { v: 4, epoch: 'epoch', seq, ts: seq, fence: 1, revision, ...row })
    return seq
  }
  const turn = (itemId: string, turnId = itemId, outcome: 'failure' | 'success' = 'failure') =>
    apply({ kind: 'item', itemId, body: { kind: 'turn', turnId, state: 'completed', outcome } })
  const command = (id: string) => {
    const { itemId, turnId } = structuredAgentSessionCommandTurn(id)
    return { itemId, settle: () => turn(itemId, turnId) }
  }
  return {
    state,
    apply,
    turn,
    command,
    live: () => journalInputOrder(state).newestTurn.failure(),
    restored: () => new JournalNewestTurn(state).failure() > 0
  }
}

describe('which failure holds the queue beneath refused commands', () => {
  it('releases when the failure beneath a refused command is revised to success', () => {
    const f = failureFold()
    const failedAt = f.turn('ordinary')
    f.command('refused').settle()
    expect(f.live()).toBe(failedAt)
    f.turn('ordinary', 'ordinary', 'success')
    expect([f.live(), f.restored()]).toEqual([0, false])
  })

  it("holds on an older command's late usage limit beneath a newer refused command", () => {
    const f = failureFold()
    const older = f.command('older')
    older.settle()
    f.command('newer').settle()
    expect(f.live()).toBe(0)
    const reported = f.apply(usageLimit(older.itemId))
    expect([f.live(), f.restored()]).toEqual([reported, true])
  })

  it('holds on a usage limit saved before its command turn row', () => {
    const f = failureFold()
    const command = f.command('out-of-order')
    f.apply(usageLimit(command.itemId))
    const settled = command.settle()
    expect([f.live(), f.restored()]).toEqual([settled, true])
  })

  it('leaves the live failure untouched when a draft adding its evidence is discarded', () => {
    const f = failureFold()
    const failedAt = f.turn('ordinary')
    const command = f.command('refused')
    command.settle()
    const pending = isolateJournalTransition(f.state, (draft) =>
      applyJournalRow(draft, {
        v: 4,
        epoch: 'epoch',
        seq: 9,
        ts: 9,
        fence: 1,
        ...usageLimit(command.itemId)
      })
    )
    expect(journalInputOrder(pending.state).newestTurn.failure()).toBe(9)
    expect(f.live()).toBe(failedAt)
  })
})

it.each([100, 1_000])(
  'checks failed-turn queue state without scanning %s history items',
  (size) => {
    const state = createJournalReducerState('session', 'epoch')
    const base = (seq: number) => ({ v: 4, epoch: 'epoch', seq, ts: seq, fence: 1 })
    for (let n = 1; n <= size; n++) {
      applyJournalRow(state, {
        ...base(n),
        kind: 'item',
        itemId: `message-${n}`,
        revision: 1,
        body: { kind: 'message', role: 'assistant', blocks: [] }
      })
    }
    const turn: JournalRow = {
      ...base(size + 1),
      kind: 'item',
      itemId: 'turn',
      revision: 1,
      body: { kind: 'turn', turnId: 'turn', state: 'running' }
    }
    applyJournalRow(state, turn)
    const order = journalInputOrder(state)
    expect(order.newestTurn.read()?.itemId).toBe('turn')
    // Drafts read the live map through keys(), so count every way of walking it.
    const walks = (['keys', 'values', 'entries', 'forEach', Symbol.iterator] as const).map(
      (method) => vi.spyOn(state.items, method)
    )
    const failed: JournalRow = {
      ...turn,
      ...base(size + 2),
      revision: 2,
      body: { kind: 'turn', turnId: 'turn', state: 'completed', outcome: 'failure' }
    }
    const pending = isolateJournalTransition(state, (draft) => applyJournalRow(draft, failed))
    expect(failedQueueTurnSequence(order.newestTurn.failure(), 0)).toBe(0)
    const committed = pending.adopt()
    for (let n = 0; n < 10; n++) {
      const owner = journalInputOrder(committed)
      expect(failedQueueTurnSequence(owner.newestTurn.failure(), 0)).toBe(size + 2)
      expect(owner.head(committed, null)).toBeUndefined()
    }
    // A command refused on its own terms, then the agent's late usage-limit row for it.
    const command = structuredAgentSessionCommandTurn('late')
    applyJournalRow(committed, {
      ...base(size + 3),
      kind: 'item',
      itemId: command.itemId,
      revision: 1,
      body: { kind: 'turn', turnId: command.turnId, state: 'completed', outcome: 'failure' }
    })
    expect(journalInputOrder(committed).newestTurn.failure()).toBe(size + 2)
    applyJournalRow(committed, { ...base(size + 4), ...usageLimit(command.itemId) })
    expect(journalInputOrder(committed).newestTurn.failure()).toBe(size + 4)
    for (const walk of walks) {
      expect(walk).not.toHaveBeenCalled()
      walk.mockRestore()
    }
    for (const itemId of [command.itemId, 'turn']) {
      applyJournalRow(committed, {
        ...base(committed.lastSequence + 1),
        kind: 'tombstone',
        itemId,
        revision: 3
      })
    }
    expect(journalInputOrder(committed).newestTurn.read()).toBeNull()
  }
)

it.each([100, 1_000])(
  'publishes a failure pause without walking %s recovered sends',
  async (size) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-failed-queue-scaling-'))
    const journals = createTrackedJournalOpener()
    const identity = {
      sessionId: 's',
      workspaceId: 'w',
      hostId: 'h',
      agent: 'codex' as const,
      providerHandle: codexProviderHandle('thread')
    }
    const providerHandle = agentSessionJournalProviderHandle(identity)
    const body = { kind: 'message' as const, role: 'user' as const, blocks: [] }
    try {
      const journal = await journals.open({
        identity,
        stateDirectory: root
      })
      await journal.queuedMessages.insert({ messageId: 'waiting', body })
      const state = journal.queuedMessages.inputState()
      let seq = state.lastSequence
      const base = () => ({ v: 4, epoch: state.epoch, seq: ++seq, ts: seq, fence: 1 })
      for (let n = 0; n < size; n++) {
        const clientMessageId = `old-${n}`
        applyJournalRow(state, {
          ...base(),
          kind: 'submission',
          clientMessageId,
          body,
          providerHandle,
          payloadFingerprint: clientMessageId,
          handoverRecorded: true
        })
        applyJournalRow(state, {
          ...base(),
          kind: 'dispatch',
          clientMessageId,
          state: 'unknown',
          reason: 'host_restarted_before_acknowledgement',
          providerItemId: null,
          recovered: true
        })
      }
      applyJournalRow(state, {
        ...base(),
        kind: 'item',
        itemId: 'turn',
        revision: 1,
        body: { kind: 'turn', turnId: 'turn', state: 'completed', outcome: 'failure' }
      })
      const work = new StructuredAgentSessionCurrentWork(journal, null)
      const gate = () => ({ record: null, work })
      const published = readQueuePublication(journal, gate)
      expect(published.queuePause).toEqual({ reason: 'failed' })
      // The working check walks entered sends on main already; this contract covers the pause.
      vi.spyOn(journal.inputOrder, 'enteredSubmissions').mockReturnValue([])
      // Count every read of a recovered send's state, however publication reaches it.
      let reads = 0
      for (const entry of state.submissions.values()) {
        const dispatchState = entry.dispatchState
        Object.defineProperty(entry, 'dispatchState', {
          get: () => (reads++, dispatchState),
          configurable: true,
          enumerable: true
        })
      }
      for (let n = 0; n < 10; n++) {
        expect(readQueuePublication(journal, gate)).toBe(published)
      }
      expect(reads).toBe(0)
    } finally {
      vi.restoreAllMocks()
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  }
)

/** An AVL tree of T sources is at most 1.45 log2(T + 2) deep; per level, one source's update
 * reaches a node, its sibling and their cached summaries, plus the row's fixed input-order work. */
const perSource = (sources: number) => 32 * (Math.ceil(Math.log2(sources + 2)) + 1)

/** Commits rows through real isolated transactions, counting each one's derived draft nodes and
 * every walk of the saved items or of any map the failure projection owns. */
function sourceIndexFold(size: number) {
  const state = createJournalReducerState('session', 'epoch')
  const revisions = new Map<string, number>()
  const revise = (itemId: string) => {
    const revision = (revisions.get(itemId) ?? 0) + 1
    revisions.set(itemId, revision)
    return revision
  }
  let seq = 0
  const base = () => ({ v: 4, epoch: 'epoch', seq: ++seq, ts: seq, fence: 1 }) as const
  const row = (mutation: Record<string, unknown> & { itemId: string }): JournalRow =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callers build item and tombstone rows of the v4 schema.
    ({ ...base(), kind: 'item', revision: revise(mutation.itemId), ...mutation }) as JournalRow
  const turn = (itemId: string, turnId: string, outcome?: 'failure' | 'success') => ({
    kind: 'item',
    itemId,
    body: outcome
      ? { kind: 'turn', turnId, state: 'completed', outcome }
      : { kind: 'turn', turnId, state: 'running' }
  })
  const refusal = (id: string) => {
    const { itemId, turnId } = structuredAgentSessionCommandTurn(id)
    const settle = (): JournalRow => ({
      ...base(),
      kind: 'lifecycle-batch',
      settlementId: `command-settled:${id}`,
      mutations: [
        {
          kind: 'item',
          itemId,
          revision: revise(itemId),
          body: { kind: 'turn', turnId, state: 'completed', outcome: 'failure' }
        },
        {
          kind: 'item',
          itemId: `orca:command-result:${id}`,
          revision: 1,
          body: {
            kind: 'status',
            tone: 'error',
            ...agentSessionFailureWords(agentSessionFailureFact('commandRefused'), {
              surface: 'row'
            })
          },
          turnScope: { kind: 'turn', turnItemId: itemId }
        }
      ]
    })
    return { itemId, turnId, settle }
  }
  for (let n = 0; n < size; n++) {
    applyJournalRow(
      state,
      row({ itemId: `message-${n}`, body: { kind: 'message', role: 'assistant', blocks: [] } })
    )
  }
  const owner = journalInputOrder(state).newestTurn
  const walks: { mock: { calls: readonly unknown[] } }[] = []
  let derived = 0
  const watch = () => {
    const maps = [state.items, ...Object.values(owner).filter((value) => value instanceof Map)]
    for (const map of maps) {
      for (const method of ['keys', 'values', 'entries', 'forEach', Symbol.iterator] as const) {
        walks.push(vi.spyOn(map, method))
      }
    }
  }
  /** Keeps the most draft nodes one transaction reached per source it changed. */
  const commit = (rows: JournalRow[], sources = 1) => {
    const pending = isolateJournalTransition(state, (draft) => {
      for (const next of rows) {
        applyJournalRow(draft, next)
      }
    })
    derived = Math.max(derived, pending.trackedDerived() / sources)
    pending.adopt()
    return rows.at(-1)!.seq
  }
  return {
    state,
    owner,
    row,
    turn,
    refusal,
    commit,
    watch,
    counts: () => ({ walks: walks.reduce((sum, spy) => sum + spy.mock.calls.length, 0), derived }),
    status: (turnItemId: string, itemId: string) => row({ ...usageLimit(turnItemId), itemId })
  }
}

describe.each([100, 1_000])('failure source index cost with %s commands', (size) => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('updates only touched sources for refused chains and late or early evidence', () => {
    const f = sourceIndexFold(size)
    const failedAt = f.commit([f.row(f.turn('ordinary', 'ordinary', 'failure'))])
    const chain = Array.from({ length: size }, (_, n) => f.refusal(`chain-${n}`))
    for (const command of chain) {
      applyJournalRow(f.state, command.settle())
    }
    f.watch()
    for (let n = 0; n < 10; n++) {
      expect(f.commit([f.refusal(`more-${n}`).settle()])).toBeGreaterThan(failedAt)
      expect(f.owner.failure()).toBe(failedAt)
    }
    for (let n = 0; n < 10; n++) {
      const late = chain[size / 2 + n]
      const reported = f.commit([f.status(late.itemId, `late-${n}`)])
      expect(f.owner.failure()).toBe(reported)
    }
    for (let n = 0; n < 10; n++) {
      const early = f.refusal(`early-${n}`)
      f.commit([f.status(early.itemId, `early-report-${n}`)])
      const settled = f.commit([early.settle()])
      expect(f.owner.failure()).toBe(settled)
      expect(f.owner.read()?.itemId).toBe(early.itemId)
    }
    const { walks, derived } = f.counts()
    expect(walks).toBe(0)
    expect(derived).toBeLessThanOrEqual(perSource(2 * size + 32))
  })

  it('demotes a started command to the newest qualifying one without a walk', () => {
    const f = sourceIndexFold(size)
    const successes = Array.from({ length: size }, (_, n) =>
      structuredAgentSessionCommandTurn(`ok-${n}`)
    )
    for (const { itemId, turnId } of successes) {
      applyJournalRow(f.state, f.row(f.turn(itemId, turnId, 'success')))
    }
    f.watch()
    for (let n = 0; n < 10; n++) {
      const command = f.refusal(`refused-${n}`)
      f.commit([f.row(f.turn(command.itemId, command.turnId))])
      expect(f.owner.read()?.itemId).toBe(command.itemId)
      f.commit([command.settle()])
      expect([f.owner.read()?.itemId, f.owner.failure()]).toEqual([command.itemId, 0])
    }
    f.commit([f.status(successes.at(-1)!.itemId, 'qualified')])
    expect(f.owner.failure()).toBe(0)
    const { walks, derived } = f.counts()
    expect(walks).toBe(0)
    expect(derived).toBeLessThanOrEqual(perSource(size + 10))
  })

  it('keeps a revised anchor and its failure position without visiting newer commands', () => {
    const f = sourceIndexFold(size)
    const failedAt = f.commit([f.row(f.turn('ordinary', 'ordinary', 'failure'))])
    for (let n = 0; n < size; n++) {
      applyJournalRow(f.state, f.refusal(`chain-${n}`).settle())
    }
    f.watch()
    for (let n = 0; n < 10; n++) {
      f.commit([f.row(f.turn('ordinary', 'ordinary', 'failure'))])
      expect(f.owner.failure()).toBe(failedAt)
    }
    const { walks, derived } = f.counts()
    expect(walks).toBe(0)
    expect(derived).toBeLessThanOrEqual(perSource(size + 1))
  })

  it('removes rewound commands, including the actual latest, without rebuilding', () => {
    const f = sourceIndexFold(size)
    f.commit([f.row(f.turn('ordinary', 'ordinary', 'failure'))])
    const chain = Array.from({ length: size }, (_, n) => f.refusal(`chain-${n}`))
    for (const command of chain) {
      applyJournalRow(f.state, command.settle())
    }
    f.watch()
    // The newest ten one by one, each the actual latest when removed.
    for (const command of chain.slice(-10).toReversed()) {
      f.commit([f.row({ kind: 'tombstone', itemId: command.itemId })])
      expect(f.owner.read()?.itemId).not.toBe(command.itemId)
    }
    // Then the rest in one rewind transaction, oldest first, as the writer emits them.
    const rewound = chain
      .slice(0, -10)
      .map((command) => f.row({ kind: 'tombstone', itemId: command.itemId }))
    const boundary = f.commit(rewound, rewound.length)
    // What lay beneath them has unknown settlement order: no earlier Resume releases it.
    expect([f.owner.read()?.itemId, f.owner.failure()]).toEqual(['ordinary', boundary])
    f.commit([f.row({ kind: 'tombstone', itemId: 'ordinary' })])
    expect([f.owner.read(), f.owner.failure()]).toEqual([null, 0])
    const { walks, derived } = f.counts()
    expect(walks).toBe(0)
    expect(derived).toBeLessThanOrEqual(perSource(size + 1))
  })
})
