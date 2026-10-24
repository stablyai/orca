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
import { isStructuredRewindTarget, structuredRewindCut } from './structured-rewind-cut'

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
  // One child turn spans both main turns, so membership must follow main-turn scope.
  await append(item('child', 'c', 0), 'child in a', 'a')
  const mainB: AgentJournalItemBody = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'main b' }]
  }
  await journal.appendItem(item('main', 'b'), mainB, {
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
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
  expect(cut!.kept.map(({ body }) => body)).not.toContainEqual(mainB)
})

it('rewinds only to a message that opened its turn, and still cuts at one already saved', async () => {
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
  const claude = (uuid: string) => ({ provider: 'claude' as const, sessionId: 'claude-1', uuid })
  const key = (uuid: string) => agentJournalItemKey(claude(uuid))
  const user = (uuid: string): AgentJournalItemBody => ({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: uuid }]
  })
  const turnRecord = async (id: string, opener: string) => {
    const turn = { provider: 'orca' as const, clientMessageId: id }
    await journal.appendItem(
      turn,
      { kind: 'turn', turnId: id, state: 'completed', userItemId: key(opener) },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    return { kind: 'turn' as const, turnItemId: agentJournalItemKey(turn) }
  }
  const first = await turnRecord('turn-1', 'm1')
  await journal.appendItem(claude('m1'), user('m1'), { fence: 1, turnScope: first })
  await journal.appendItem(claude('a1'), text('a1'), { fence: 1, turnScope: first })
  const second = await turnRecord('turn-2', 'm2')
  await journal.appendItem(claude('m2'), user('m2'), {
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  await journal.appendItem(claude('a2'), text('a2'), { fence: 1, turnScope: second })
  await journal.appendItem(claude('m3'), user('m3'), { fence: 1, turnScope: second })

  expect(['m1', 'm2', 'm3'].map((uuid) => isStructuredRewindTarget(journal, key(uuid)))).toEqual([
    true,
    true,
    false
  ])
  expect(
    structuredRewindCut(journal, { itemId: key('m3'), provider: 'claude', nativeId: 'claude-1' })
  ).toMatchObject({ beforeMessage: { uuid: 'm3' } })
})
