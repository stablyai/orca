// A write has landed in the fold when its call returns, except during an owed import, when it lands
// in queue order. A write issued from inside a running write joins the line behind it, never nested.
// A read in the queue always settles: behind a write that failed, and refused once closed.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { openJournalOwingImport } from './journal-owed-import-test-support'
import type { AgentSessionJournal } from './journal-store'
import { openAgentSessionJournal } from './journal-store-factory'
import { JournalWriteQueue } from './journal-write-queue'

const IDENTITY = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
} as const

const reply = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text }]
})

const item = (ordinal: number): AgentJournalItemIdentity => ({
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal
})

const OPTIONS = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }

let root = ''
const opened: AgentSessionJournal[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-write-queue-'))
})

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((journal) => journal.close()))
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

async function idleJournal(): Promise<AgentSessionJournal> {
  const journal = await openAgentSessionJournal({
    identity: IDENTITY,
    database: openTestJournalHostDatabase(root)
  })
  opened.push(journal)
  return journal
}

async function journalOwingImport(): Promise<{ journal: AgentSessionJournal; history: number }> {
  const { journal, history } = await openJournalOwingImport({
    stateDirectory: root,
    identity: IDENTITY
  })
  opened.push(journal)
  return { journal, history: history.length }
}

function sequenceOf(journal: AgentSessionJournal, ordinal: number): number | undefined {
  const key = agentJournalItemKey(item(ordinal))
  let found: number | undefined
  journal.visitItems((itemId, sequence) => {
    if (itemId === key) {
      found = sequence
    }
  })
  return found
}

describe('when a journal write lands', () => {
  it('is in the fold when its call returns, on an idle queue', async () => {
    const journal = await idleJournal()
    const before = journal.cursor().sequence

    const first = journal.appendItem(item(1), reply('one'), OPTIONS)
    expect(journal.itemBody(agentJournalItemKey(item(1)))).toEqual(reply('one'))
    const second = journal.appendItem(item(2), reply('two'), OPTIONS)
    expect(journal.cursor().sequence).toBe(before + 2)
    expect(sequenceOf(journal, 2)).toBeGreaterThan(sequenceOf(journal, 1)!)

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })

  it('lands in queue order, behind the history it copies, while an import is owed', async () => {
    const { journal, history } = await journalOwingImport()

    const first = journal.appendItem(item(1), reply('one'), OPTIONS)
    const second = journal.appendItem(item(2), reply('two'), OPTIONS)
    // Neither has landed: both wait behind the copy the first write pays.
    expect(journal.itemBody(agentJournalItemKey(item(1)))).toBeNull()
    expect(journal.importPending).toBe(true)

    await second
    await first
    expect(journal.importPending).toBe(false)
    expect(sequenceOf(journal, 1)).toBe(history + 1)
    expect(sequenceOf(journal, 2)).toBe(history + 2)
    // The copy is paid: the next write lands at its call again.
    journal.appendItem(item(3), reply('three'), OPTIONS).catch(() => undefined)
    expect(sequenceOf(journal, 3)).toBe(history + 3)
  })

  it('joins the line behind a write it was issued from inside, never nested in it', async () => {
    const journal = await idleJournal()
    let inner: Promise<unknown> | null = null
    let innerLandedDuringOuter = false

    // Issued from inside the outer write, before that write has committed its row.
    const outer = journal.appendResolvedItem(() => {
      inner = journal.appendItem(item(2), reply('inner'), OPTIONS)
      innerLandedDuringOuter = journal.itemBody(agentJournalItemKey(item(2))) !== null
      return { identity: item(1), body: reply('outer') }
    }, OPTIONS)

    expect(innerLandedDuringOuter).toBe(false)
    expect(journal.itemBody(agentJournalItemKey(item(1)))).toEqual(reply('outer'))
    expect(journal.itemBody(agentJournalItemKey(item(2)))).toBeNull()
    await outer
    await inner
    expect(sequenceOf(journal, 2)).toBe(sequenceOf(journal, 1)! + 1)
  })
})

describe('the journal write queue', () => {
  it('runs a write before it returns when nothing is owed or running', () => {
    const queue = new JournalWriteQueue('session-1')
    const ran: string[] = []
    void queue.serialize(() => {
      ran.push('write')
    })
    expect(ran).toEqual(['write'])
  })

  it('takes only a synchronous body', async () => {
    const queue = new JournalWriteQueue('session-1')
    // @ts-expect-error an await inside a write would let a later write land first
    await queue.serialize(async () => undefined)
  })

  it('answers a write that throws with a rejection, never a throw', async () => {
    const queue = new JournalWriteQueue('session-1')
    const failed = queue.serialize(() => {
      throw new Error('disk I/O error')
    })
    await expect(failed).rejects.toThrow('disk I/O error')
    const ran: string[] = []
    void queue.serialize(() => {
      ran.push('next')
    })
    expect(ran).toEqual(['next'])
  })

  it('runs a write issued from inside a running one after it, in issue order', async () => {
    const queue = new JournalWriteQueue('session-1')
    const ran: string[] = []
    let nested: Promise<void> | null = null
    const outer = queue.serialize(() => {
      nested = queue.serialize(() => {
        ran.push('nested')
      })
      ran.push('outer')
    })
    const after = queue.serialize(() => {
      ran.push('after')
    })
    expect(ran).toEqual(['outer'])
    await Promise.all([outer, nested, after])
    expect(ran).toEqual(['outer', 'nested', 'after'])
  })

  it('runs every write admitted while work is owed after it, in order', async () => {
    const queue = new JournalWriteQueue('session-1')
    const ran: string[] = []
    const owed = Promise.withResolvers<void>()
    queue.owe(async () => {
      await owed.promise
      ran.push('owed')
    })
    const first = queue.serialize(() => {
      ran.push('first')
    })
    const read = queue.readInOrder(() => ran.push('read'))
    owed.resolve()
    const second = queue.serialize(() => {
      ran.push('second')
    })
    await Promise.all([first, read, second])
    expect(ran).toEqual(['owed', 'first', 'read', 'second'])
    expect(queue.owing).toBe(false)
  })
})

describe('a read in the journal write queue', () => {
  it('runs at once when no write waits', () => {
    const queue = new JournalWriteQueue('session-1')
    const ran: string[] = []
    void queue.readInOrder(() => ran.push('read'))
    expect(ran).toEqual(['read'])
  })

  it('does not pay owed work, and runs behind a write that pays it', async () => {
    const queue = new JournalWriteQueue('session-1')
    const ran: string[] = []
    queue.owe(async () => {
      ran.push('owed')
    })
    void queue.readInOrder(() => ran.push('read before'))
    expect(ran).toEqual(['read before'])
    const write = queue.serialize(() => {
      ran.push('write')
    })
    const read = queue.readInOrder(() => ran.push('read after'))
    await Promise.all([write, read])
    expect(ran).toEqual(['read before', 'owed', 'write', 'read after'])
  })

  it('runs behind a write that failed', async () => {
    const queue = new JournalWriteQueue('session-1')
    queue.owe(async () => undefined)
    const failed = queue.serialize(() => {
      throw new Error('disk I/O error')
    })
    const read = queue.readInOrder(() => 'read')
    await expect(failed).rejects.toThrow('disk I/O error')
    await expect(read).resolves.toBe('read')
  })

  it('is refused at once after close, not queued', async () => {
    const queue = new JournalWriteQueue('session-1')
    queue.markClosed()
    await expect(queue.readInOrder(() => 'read')).rejects.toMatchObject({ code: 'journal_closed' })
  })
})
