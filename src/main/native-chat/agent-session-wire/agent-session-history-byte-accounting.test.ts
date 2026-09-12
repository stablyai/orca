import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { readAgentSessionHistory } from './agent-session-history-page'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

const journals = createTrackedJournalOpener()
let root: string
let clock = 1_000
let epochs = 0
let journal: AgentSessionJournal

function tick(): number {
  clock += 1
  return clock
}

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function body(text: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
}

async function appendItems(count: number, text: string): Promise<void> {
  for (let ordinal = 1; ordinal <= count; ordinal += 1) {
    await journal.appendItem(item(ordinal), body(`${text}-${ordinal}`), { fence: 1 })
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-wire-history-'))
  clock = 1_000
  epochs = 0
  journal = await journals.open({
    identity: IDENTITY,
    journalDir: root,
    now: tick,
    mintEpoch: () => {
      epochs += 1
      return `epoch-${epochs}`
    }
  })
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

it.each([1, 100, 200])('serializes each of %i unchanged forward page items once', async (count) => {
  const cursor = journal.cursor()
  await appendItems(count, 'x'.repeat(8_000))
  const snapshot = journal.snapshot()
  const stringify = JSON.stringify
  let itemSerializations = 0
  JSON.stringify = ((value: unknown, ...args: unknown[]) => {
    if (value && typeof value === 'object' && 'itemId' in value && 'body' in value) {
      itemSerializations++
    }
    return Reflect.apply(stringify, JSON, [value, ...args])
  }) as typeof JSON.stringify
  try {
    const result = readAgentSessionHistory(
      journal,
      {
        sessionId: 'session-1',
        direction: 'after',
        limit: count,
        cursor
      },
      snapshot
    )
    expect(result.ok).toBe(true)
    expect(result.page.items).toHaveLength(count)
    expect(itemSerializations).toBe(count)
  } finally {
    JSON.stringify = stringify
  }
})
