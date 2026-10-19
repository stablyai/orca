// A rewind keeps the journal's own rows of the turns before the cut. A subagent's rows belong to
// the main turn they arrived in, whatever their own thread's turn ids, so one that lands after the
// cut stays with a kept turn and goes with an undone one.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { structuredRewindCut } from './structured-rewind-cut'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('main')
}

function item(threadId: string, turnId: string, ordinal = 0): AgentJournalItemIdentity {
  return { provider: 'codex', threadId, turnId, ordinal }
}
function text(value: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: value }] }
}

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-rewind-cut-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

it("keeps a subagent row with the main turn it arrived in, across the subagent's own turn", async () => {
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
  const append = async (identity: AgentJournalItemIdentity, value: string, turn?: string) => {
    const record = turn ? { provider: 'orca' as const, clientMessageId: `turn-${turn}` } : null
    await journal.appendItem(identity, text(value), {
      fence: 1,
      turnScope: record
        ? { kind: 'turn', turnItemId: agentJournalItemKey(record) }
        : AGENT_JOURNAL_THREAD_SCOPE
    })
  }
  for (const turn of ['a', 'b']) {
    await journal.appendItem(
      { provider: 'orca', clientMessageId: `turn-${turn}` },
      { kind: 'turn', turnId: turn, state: 'completed' },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  await append(item('main', 'a'), 'main a')
  // One subagent turn spans both main turns.
  await append(item('child', 'c', 0), 'child in a', 'a')
  await append(item('main', 'b'), 'main b')
  await append(item('child', 'c', 1), 'child in b', 'b')
  await append(item('child', 'c', 2), 'late child in a', 'a')

  const cut = structuredRewindCut(journal, {
    itemId: agentJournalItemKey(item('main', 'b')),
    provider: 'codex',
    nativeId: 'main'
  })

  expect(cut).toMatchObject({ beforeTurnId: 'b', keptTurnId: 'a' })
  expect(cut!.kept.map(({ body }) => body)).toEqual(
    expect.arrayContaining([text('main a'), text('child in a'), text('late child in a')])
  )
  expect(cut!.kept.map(({ body }) => body)).not.toContainEqual(text('child in b'))
  expect(cut!.kept.map(({ body }) => body)).not.toContainEqual(text('main b'))
})
