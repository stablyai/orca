import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { structuredAgentSessionStopNoteIdentity } from './structured-agent-session-command-turn'

export const journals = createTrackedJournalOpener()

export const turnIdentity = { provider: 'orca', clientMessageId: 'turn-1' } as const

export const turnItemId = agentJournalItemKey(turnIdentity)

export const noteIdentity = structuredAgentSessionStopNoteIdentity('turn-1')

export const noteId = agentJournalItemKey(noteIdentity)

export const scope = { kind: 'turn', turnItemId } as const

export const unconfirmed: AgentJournalItemBody = {
  kind: 'status',
  ...agentSessionFailureWords(agentSessionFailureFact('cancelUnconfirmed'), { surface: 'row' }),
  tone: 'error',
  presentation: 'error'
}

export const ordinary = { kind: 'status', text: 'Cancellation requested.' }

let root: string

let journal: AgentSessionJournal

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-stop-note-projection-'))
  journal = await journals.open({
    identity: {
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: root
  })
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

export async function turn(state: AgentJournalTurnLifecycle['state'], legacy = false) {
  const lifecycle: AgentJournalTurnLifecycle = { turnId: 'turn-1', state }
  await journal.appendItem(
    turnIdentity,
    legacy
      ? { kind: 'status', text: 'Turn ended', turnLifecycle: lifecycle }
      : { kind: 'turn', ...lifecycle },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

export async function note(body: AgentJournalItemBody = unconfirmed) {
  await journal.appendItem(noteIdentity, body, { fence: 1, turnScope: scope })
}

export function readNote() {
  return journal.snapshot().items.find((item) => item.itemId === noteId)!
}

export function rows() {
  const result = journal.readSince({ epoch: journal.epoch, sequence: 0 })
  if (!result.ok) {
    throw new Error(result.reset)
  }
  return result.rows
}

export const fixture = {
  get journal() {
    return journal
  },
  set journal(value: typeof journal) {
    journal = value
  },
  get root() {
    return root
  },
  set root(value: typeof root) {
    root = value
  }
}
