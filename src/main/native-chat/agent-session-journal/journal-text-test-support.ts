import type { ClaudeSubagentLinkageSource } from '../../claude/claude-subagent-linkage'
import type { AgentSessionJournal } from './journal-store'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { iterateJournalEpochRows } from './journal-row-table'
import { parseJournalRow } from './journal-row-schema'

export const rootTextProducer: ClaudeSubagentLinkageSource = {
  linkageFor: () => {
    throw new Error('root block consulted child resolver')
  },
  settledLinkageFor: () => {
    throw new Error('root block consulted child resolver')
  }
}

export const textJournals = createTrackedJournalOpener()
const roots: string[] = []
export const textIdentityOf = (uuid: string): AgentJournalItemIdentity => ({
  provider: 'claude',
  sessionId: 'provider',
  uuid
})
export const textIdentity = textIdentityOf('reply')
export const textBody = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text }]
})
export const textOptions = { fence: 7, ownerFence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
export async function closeTextJournals(): Promise<void> {
  await textJournals.closeAll()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
}
export async function textRig() {
  const root = await mkdtemp(join(tmpdir(), 'orca-text-contract-'))
  roots.push(root)
  let now = 100
  const settings = {
    stateDirectory: root,
    identity: {
      sessionId: 'chat',
      workspaceId: 'folder',
      hostId: 'host',
      agent: 'claude' as const,
      providerHandle: null
    },
    now: () => now
  }
  const journal = await textJournals.open(settings)
  const database = openTestJournalHostDatabase(root)
  const rows = () =>
    [...iterateJournalEpochRows(database.db, 'chat', journal.epoch)].map((entry) => {
      const parsed = parseJournalRow(entry.rowJson, true)
      if (!parsed.ok) {
        throw new Error('invalid test row')
      }
      return parsed.row
    })
  const stream = (baseLength: number, suffix: string, _whole: string) =>
    journal.appendItem(textIdentity, textBody(''), {
      ...textOptions,
      streamText: { operation: baseLength === 0 ? 'start' : 'append', field: 0, baseLength, suffix }
    })
  const append = (id: AgentJournalItemIdentity, n: number, ownerFence = 7) =>
    journal.appendItem(id, textBody(''), {
      ...textOptions,
      fence: Math.max(7, ownerFence),
      ownerFence,
      streamText: { operation: n === 0 ? 'start' : 'append', field: 0, baseLength: n, suffix: 'a' }
    })
  return {
    root,
    settings,
    journal,
    database,
    rows,
    stream,
    append,
    time: (value: number) => {
      now = value
    }
  }
}

export async function flushJournalTextIdle(journal: AgentSessionJournal): Promise<void> {
  for (let unit = 0; unit < 8; unit++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await journal.readInOrder(() => undefined)
  }
}
