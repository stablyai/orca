// `close()`: enqueue-time admission, and the fulfilled/rejected split.
//
// The two failures this file exists to prevent: an append enqueued in the same
// turn as `close()` being rejected AFTER the queue accepted it, and a rejected
// close leaving a connection live but permanently unreachable through the API.

import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { journalDatabaseFile } from './journal-paths'
import type { AgentSessionJournal } from './journal-store'
import { createTrackedJournalOpener } from './journal-store-test-open'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string
const journals = createTrackedJournalOpener()

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function body(value: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: value }] }
}

function openJournal(): Promise<AgentSessionJournal> {
  return journals.open({ identity: IDENTITY, journalDir: root })
}

/** Replaces the store's own release step, which is the only step that can
 *  reject the attempt in production. */
function injectReleaseFailure(journal: AgentSessionJournal): {
  calls: () => number
  stopFailing: () => void
} {
  const internals = journal as unknown as { database: { db: { close: () => void } } }
  const release = internals.database.db.close.bind(internals.database.db)
  let calls = 0
  let failing = true
  internals.database.db.close = () => {
    calls += 1
    if (failing) {
      throw new Error('injected release failure')
    }
    release()
  }
  return { calls: () => calls, stopFailing: () => (failing = false) }
}

async function exists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-close-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('closed-state admission happens at enqueue', () => {
  it('completes a write enqueued in the same turn as the close', async () => {
    const journal = await openJournal()
    const append = journal.appendItem(item(1), body('before'), { fence: 1 })
    const closed = journal.close()

    await expect(append).resolves.toBeDefined()
    await expect(closed).resolves.toBeUndefined()
    const reopened = await openJournal()
    expect(reopened.snapshot().items).toHaveLength(1)
  })

  it('refuses a write offered while the close is still in flight, without queueing it', async () => {
    const journal = await openJournal()
    const closing = journal.close()
    const refused = journal.appendItem(item(1), body('during'), { fence: 1 })

    // The rejection is available before the close step has run: it never joined
    // the queue, so nothing is ever chained behind a close.
    await expect(refused).rejects.toMatchObject({ code: 'journal_closed' })
    await expect(closing).resolves.toBeUndefined()
  })

  it('refuses every write entry point after the close has settled', async () => {
    const journal = await openJournal()
    await journal.close()
    const settle = (attempt: Promise<unknown>): Promise<unknown> =>
      attempt.then(
        () => new Error('resolved instead of refusing'),
        (error: unknown) => error
      )
    const refusals = [
      settle(journal.appendItem(item(1), body('after'), { fence: 1 })),
      settle(journal.appendTombstone(item(3), { fence: 1 })),
      settle(
        journal.appendSubmission({
          clientMessageId: 'cm_1',
          payloadFingerprint: 'f',
          body: { kind: 'message', role: 'user', blocks: [] },
          fence: 1
        })
      ),
      settle(journal.resolveDispatch({ clientMessageId: 'cm_1', state: 'rejected', fence: 1 })),
      settle(
        journal.appendLifecycleBatch({
          settlementId: 'settle',
          fence: 1,
          mutations: [{ kind: 'item', identity: item(4), body: body('x') }]
        })
      ),
      settle(journal.rollEpoch('handle_forked', 1)),
      settle(journal.replaceEpochItems('handle_forked', 1, []))
    ]
    for (const refusal of refusals) {
      expect(await refusal).toMatchObject({ code: 'journal_closed' })
    }
  })

  // The property part 1 rests on: every entry point reaches the gate in the
  // caller's own turn, so a refusal never advances the queue.
  it('rejects without waiting for the queue to advance', async () => {
    const journal = await openJournal()
    const inFlight = journal.appendItem(item(1), body('admitted'), { fence: 1 })
    const closing = journal.close()

    // Settles while the admitted append is still running: it reached the gate in
    // the caller's own turn and never joined the queue behind it.
    await expect(journal.appendItem(item(2), body('later'), { fence: 1 })).rejects.toMatchObject({
      code: 'journal_closed'
    })
    await expect(inFlight).resolves.toBeDefined()
    await expect(closing).resolves.toBeUndefined()
  })

  it('resolves a second close as a no-op without running the routine again', async () => {
    const journal = await openJournal()
    const injected = injectReleaseFailure(journal)
    injected.stopFailing()
    await journal.close()
    expect(injected.calls()).toBe(1)

    await expect(journal.close()).resolves.toBeUndefined()
    expect(injected.calls()).toBe(1)
  })
})

describe('a rejected close is a real retry', () => {
  it('retries the release, releases the handle, and then goes terminal', async () => {
    const journal = await openJournal()
    await journal.appendItem(item(1), body('durable'), { fence: 1 })
    const injected = injectReleaseFailure(journal)

    await expect(journal.close()).rejects.toThrow('injected release failure')
    expect(injected.calls()).toBe(1)

    // Write-closed anyway: retry exists to release the OS handle, never to
    // resurrect the store.
    await expect(journal.appendItem(item(2), body('after'), { fence: 1 })).rejects.toMatchObject({
      code: 'journal_closed'
    })

    injected.stopFailing()
    await expect(journal.close()).resolves.toBeUndefined()
    // The retry RE-ENTERED the release. A completion flag on it would skip the
    // one step that had not succeeded, and the handle would never be released.
    expect(injected.calls()).toBe(2)
    const dbPath = journalDatabaseFile(root)
    expect(await exists(`${dbPath}-wal`)).toBe(false)
    expect(await exists(`${dbPath}-shm`)).toBe(false)

    // Fulfilment is terminal: a third call must not issue a second db.close(),
    // which `node:sqlite` answers with ERR_INVALID_STATE.
    await expect(journal.close()).resolves.toBeUndefined()
    expect(injected.calls()).toBe(2)
  })

  it('hands concurrent callers the same outcome', async () => {
    const journal = await openJournal()
    const injected = injectReleaseFailure(journal)
    const first = journal.close()
    const second = journal.close()
    await expect(first).rejects.toThrow('injected release failure')
    await expect(second).rejects.toThrow('injected release failure')
    expect(injected.calls()).toBe(1)
  })
})

// The two rejected readings of the contract, as models, because a green run on
// the real store proves nothing about what the alternatives would have done.
describe('negative controls', () => {
  class UnconditionalNoOpClose {
    calls = 0
    private called = false
    constructor(private readonly release: () => void) {}
    async close(): Promise<void> {
      if (this.called) {
        return
      }
      this.called = true
      this.calls += 1
      this.release()
    }
  }

  class AlwaysReentrantClose {
    calls = 0
    async close(release: () => void): Promise<void> {
      this.calls += 1
      release()
    }
  }

  it('an unconditional second-call no-op leaves a failed close unreleasable', async () => {
    let failing = true
    let released = false
    const model = new UnconditionalNoOpClose(() => {
      if (failing) {
        throw new Error('injected release failure')
      }
      released = true
    })
    await expect(model.close()).rejects.toThrow('injected release failure')
    failing = false
    await expect(model.close()).resolves.toBeUndefined()
    // Fulfilled without the routine running: the handle is still held.
    expect(model.calls).toBe(1)
    expect(released).toBe(false)
  })

  it('an always-reentrant close issues the second db.close() that throws', async () => {
    let open = true
    const release = (): void => {
      if (!open) {
        throw new Error('ERR_INVALID_STATE: database is not open')
      }
      open = false
    }
    const model = new AlwaysReentrantClose()
    await model.close(release)
    await expect(model.close(release)).rejects.toThrow('database is not open')
  })
})
