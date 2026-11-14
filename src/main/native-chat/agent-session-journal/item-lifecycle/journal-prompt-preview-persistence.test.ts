import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalQuestionItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { openAgentSessionJournal } from '../journal-store-factory'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../store-lifecycle/journal-host-database-test-support'
import { boundJournalPromptBody, cancelledJournalPromptBody } from './journal-prompt-body-bounds'

let root: string | undefined

afterEach(async () => {
  await closeTestJournalHostDatabases()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

// Control characters escape to six bytes each, so this question only fits a journal row on its own.
const CONTROL = '\u0001'
// Each preview fits the 8 KiB bound, so it must come back exactly as written.
const PREVIEWS = [1, 2, 3, 4].map((q) =>
  [1, 2, 3, 4].map((o) => `layout ${q}.${o}${CONTROL.repeat(8_192 - 12)}`)
)

function largestQuestion(): AgentJournalQuestionItem {
  const questions = [1, 2, 3, 4].map((q) => ({
    id: `q${q}`,
    question: `Question ${q}${CONTROL.repeat(30_000)}`,
    multiSelect: false,
    options: [1, 2, 3, 4].map((o) => ({
      id: `q${q}:choice-${o}`,
      label: `Layout ${o}`,
      preview: PREVIEWS[q - 1]![o - 1]!
    }))
  }))
  return boundJournalPromptBody({
    kind: 'question',
    question: '4 grouped questions from Claude',
    options: [],
    questions,
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  })
}

it('saves, cancels and reopens a question whose previews make it larger than one batch', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-prompt-previews-'))
  const open = () =>
    openAgentSessionJournal({
      identity: {
        sessionId: 'session-previews',
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread-1')
      },
      database: openTestJournalHostDatabase(root!),
      now: () => 1_000
    })
  const identity = { provider: 'orca' as const, clientMessageId: 'claude-prompt:session:req-1' }
  const body = largestQuestion()
  const journal = await open()
  await journal.appendItem(identity, body, { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
  await journal.appendLifecycleBatch({
    settlementId: 'cancel-prompt',
    fence: 1,
    mutations: [
      {
        kind: 'item',
        identity,
        body: cancelledJournalPromptBody(body)!,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    ]
  })
  await journal.close()

  const reopened = await open()
  const saved = reopened
    .snapshot()
    .items.map((item) => item.body)
    .find((item): item is AgentJournalQuestionItem => item.kind === 'question')
  await reopened.close()
  expect(saved).toMatchObject({ kind: 'question', resolution: { state: 'cancelled' } })
  const previews = saved!.questions!.flatMap((question) =>
    question.options.map((option) => option.preview)
  )
  expect(previews).toEqual(PREVIEWS.flat())
})
