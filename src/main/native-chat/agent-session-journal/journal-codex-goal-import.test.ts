import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexJournalGoals } from '../../codex/codex-structured-journal-goals'
import { parseCodexGoalJournalItemId } from '../../codex/codex-goal-journal-identity'
import { currentAgentSessionThreadGoal } from '../../../shared/agent-session-thread-goal'
import { stripNoiseMessages } from '../../../shared/native-chat-noise'
import { projectStructuredItemsToNativeChat } from '../../../shared/structured-agent-session-projection'
import { createDeferredStructuredAgentSessionEventSink } from '../agent-session-wire/structured-agent-session-event-sink'
import { importLegacyTranscriptIntoJournal } from './journal-legacy-import'
import { openAgentSessionJournal } from './journal-store-factory'
import type { AgentSessionJournal } from './journal-store'

const THREAD = '00000000-0000-4000-8000-000000000001'
const fixture = await readFile(
  new URL('../fixtures/codex-0.155.1-goal.jsonl', import.meta.url),
  'utf8'
)
const roots: string[] = []
const journals: AgentSessionJournal[] = []
afterEach(async () => {
  await Promise.all(journals.splice(0).map((journal) => journal.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('adopts goal history under live identities and deduplicates resumed snapshots after reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-goal-journal-'))
  roots.push(root)
  const filePath = join(root, 'rollout.jsonl')
  await writeFile(filePath, fixture)
  const options = {
    journalDir: join(root, 'journal'),
    identity: {
      sessionId: 'session',
      workspaceId: 'folder:fixture',
      hostId: 'host',
      agent: 'codex' as const,
      providerHandle: { kind: 'codex' as const, threadId: THREAD }
    }
  }
  let journal = await openAgentSessionJournal(options)
  journals.push(journal)
  const imported = await importLegacyTranscriptIntoJournal({
    journal,
    agent: 'codex',
    sessionId: THREAD,
    fence: 1,
    options: { filePath }
  })
  expect(imported).toMatchObject({ ok: true, imported: 2 })
  const initial = journal.snapshot().items
  expect(initial.filter((item) => parseCodexGoalJournalItemId(item.itemId))).toHaveLength(1)
  await journal.close()
  journals.pop()
  journal = await openAgentSessionJournal(options)
  journals.push(journal)
  let sink = createDeferredStructuredAgentSessionEventSink()
  sink.bind({ journal, fence: 1, publish: () => {} })
  let goals = new CodexJournalGoals(sink.sink, () => ({}))
  const update = async (status: string, tokensUsed: number) => {
    goals.handle({
      threadId: THREAD,
      method: 'thread/goal/updated',
      params: {
        threadId: THREAD,
        goal: {
          threadId: THREAD,
          objective: 'Keep the scratch folder tidy.',
          status,
          tokenBudget: 2000,
          tokensUsed,
          timeUsedSeconds: tokensUsed,
          createdAt: 1790073005,
          updatedAt: 1790073005 + tokensUsed
        }
      }
    })
    expect(await sink.drained()).toEqual({ ok: true })
  }
  await update('active', 10)
  expect(journal.snapshot().items.map((item) => item.itemId)).toEqual(
    initial.map((item) => item.itemId)
  )
  expect(currentAgentSessionThreadGoal(journal.snapshot().items)).toMatchObject({
    tokensUsed: 10,
    timeUsedSeconds: 10
  })
  await update('paused', 15)
  await update('active', 20)
  await update('active', 30)
  const goalItems = () =>
    journal.snapshot().items.filter((item) => parseCodexGoalJournalItemId(item.itemId))
  expect(goalItems()).toHaveLength(3)
  expect(currentAgentSessionThreadGoal(goalItems())?.tokensUsed).toBe(20)
  const ids = goalItems().map((item) => item.itemId)
  for (let restart = 0; restart < 2; restart++) {
    goals.dispose()
    sink.close()
    await journal.close()
    journals.pop()
    journal = await openAgentSessionJournal(options)
    journals.push(journal)
    sink = createDeferredStructuredAgentSessionEventSink()
    sink.bind({ journal, fence: 1, publish: () => {} })
    goals = new CodexJournalGoals(sink.sink, () => ({}))
    const visits = vi.spyOn(journal, 'visitItems')
    await update('active', 30 + restart * 10)
    await update('active', 30 + restart * 10)
    expect(goalItems().map((item) => item.itemId)).toEqual(ids)
    expect(currentAgentSessionThreadGoal(goalItems())?.tokensUsed).toBe(30 + restart * 10)
    expect(visits).toHaveBeenCalledTimes(1)
    visits.mockRestore()
  }
  const projected = projectStructuredItemsToNativeChat(goalItems())
  expect(stripNoiseMessages(projected).map((message) => message.blocks[0])).toMatchObject([
    { type: 'text', text: 'Goal set: Keep the scratch folder tidy.' },
    { type: 'text', text: 'Goal paused: Keep the scratch folder tidy.' },
    { type: 'text', text: 'Goal set: Keep the scratch folder tidy.' }
  ])
  expect(
    stripNoiseMessages(projected.map((message) => ({ ...message, codexGoal: undefined })))
  ).toHaveLength(3)
  goals.dispose()
  sink.close()
})
