// An end the adapter could not prove is judged by the same rule an observed exit is: only work that
// was in flight reads as interrupted.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import {
  captureUnfinishedStructuredAgentSessionWork,
  settleStructuredAgentSessionDeadGeneration,
  unfinishedStructuredAgentSessionWorkWasInterrupted
} from './structured-agent-session-dead-generation-settlement'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { recordUnprovenStructuredAgentSessionEndUnderSerialize } from './structured-agent-session-unproven-end'

const SESSION = 'session-unproven-end'
const THREAD = 'thread-1'
const NOW = 1_000
const FAULT = agentSessionFailureFact('hostFault')

let root: string
let journal: AgentSessionJournal

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-unproven-end-'))
  journal = await openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { transport: 'codex-app-server', agent: 'codex', nativeId: THREAD }
    },
    database: openTestJournalHostDatabase(root),
    now: () => NOW
  })
  // The turn finished; only an approval card the agent asked for is left open.
  await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 },
    {
      kind: 'approval',
      title: 'Run command?',
      detail: null,
      options: [{ id: 'yes', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 2 },
    { kind: 'turn', turnId: 'turn-1', state: 'completed', startedAt: 900, completedAt: 950 },
    { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
})

afterEach(async () => {
  await journal.close()
  await rm(root, { recursive: true, force: true })
})

function statusRows() {
  return journal.snapshot().items.filter((item) => item.body.kind === 'status')
}

it('shows no fault row for an idle open approval when the exit was observed', async () => {
  const before = captureUnfinishedStructuredAgentSessionWork(journal)
  const show = unfinishedStructuredAgentSessionWorkWasInterrupted(before, journal, NOW)

  await settleStructuredAgentSessionDeadGeneration({
    journal,
    sessionId: SESSION,
    fence: 7,
    settlementId: `provider-exit:${SESSION}:7:generation-1`,
    pendingSubmissionReason: 'provider_exited_before_acknowledgement',
    verdict: { state: 'interrupted', completedAt: NOW },
    showUnexpectedExitOutcome: show,
    exitFailure: FAULT
  })

  expect(show).toBe(false)
  expect(statusRows()).toEqual([])
})

function reportOn(journalOf: AgentSessionJournal) {
  const session: Pick<StructuredAgentSessionHostSession, 'child' | 'journal'> = {
    child: { generation: 'generation-1', fence: 7, phase: 'ready' },
    journal: journalOf
  }
  recordUnprovenStructuredAgentSessionEndUnderSerialize(
    { sessions: new Map([[SESSION, session]]), now: () => NOW },
    SESSION,
    { generation: 'generation-1', fence: 7 },
    { reason: 'journal sink failure', failure: FAULT }
  )
  return session.child?.close
}

it('judges the same idle approval not interrupted when the end could not be proven', () => {
  expect(reportOn(journal)).toMatchObject({
    cause: 'host-stop',
    reported: { reason: 'journal sink failure', failure: FAULT, interruptedWork: false }
  })
})

it('judges a turn still running when the end was reported interrupted', async () => {
  await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-2', ordinal: 1 },
    { kind: 'turn', turnId: 'turn-2', state: 'running', startedAt: 990 },
    { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )

  expect(reportOn(journal)?.reported).toMatchObject({ interruptedWork: true })
})
