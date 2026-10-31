import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

export const SESSION_ID = 'session-1'

export const THREAD_ID = 'thread-abc'

export const TURN_ID = 'turn-1'

export const LIFECYCLE_KEY = 'legacy:codex:session-1:turn-lifecycle%3Aturn-1'

export const USER_ITEM_ID = 'codex:thread-abc:turn-1:0'

export type Row = { key: string; body: AgentJournalItemBody }

export function recorder() {
  const rows: Row[] = []
  const tombstones: string[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity: AgentJournalItemIdentity, body) =>
      rows.push({ key: agentJournalItemKey(identity), body }),
    appendTombstone: (identity) => tombstones.push(agentJournalItemKey(identity)),
    publish: () => {}
  }
  return { sink, rows, tombstones }
}

export function reduced(rows: readonly Row[]): Row[] {
  const latest = new Map<string, Row>()
  for (const row of rows) {
    latest.set(row.key, row)
  }
  return [...latest.values()]
}

export function notification(
  method: string,
  params: unknown,
  observedAt?: number
): CodexStructuredSessionEvent {
  return {
    type: 'notification',
    sessionId: SESSION_ID,
    threadId: THREAD_ID,
    method,
    params,
    ...(observedAt !== undefined ? { observedAt } : {})
  }
}

export function translatorFor(tap: ReturnType<typeof recorder>, now?: () => number) {
  return createCodexJournalTranslator({
    sink: tap.sink,
    sessionId: SESSION_ID,
    primaryThreadId: () => THREAD_ID,
    ...(now ? { now } : {})
  })
}

export const journals = createTrackedJournalOpener()

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-turn-lifecycle-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
  vi.useRealTimers()
})

export const fixture = {
  get root() {
    return root
  },
  set root(value: typeof root) {
    root = value
  }
}
