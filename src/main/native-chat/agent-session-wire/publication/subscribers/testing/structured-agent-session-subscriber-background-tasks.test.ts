import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { claudeProviderHandle } from '../../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { AgentSessionSubscribeEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionBackgroundTaskState } from '../../../../../../shared/agent-session/agent-session-background-task-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../../../../shared/agent-session/structured-agent-session-reducer'
import type { AgentSessionJournal } from '../../../../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { AgentSessionSubscribers } from '../structured-agent-session-subscribers'

const SESSION = 'roster-session'
const MONITORING: AgentSessionBackgroundTaskState = {
  state: 'monitoring',
  tasks: [{ id: 'bbpijar3m', kind: 'command', description: 'watch CI' }]
}

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-subscriber-roster-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function openJournal(name: string): Promise<AgentSessionJournal> {
  return journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('provider-1', null)
    },
    stateDirectory: join(root, name)
  })
}

async function appendRow(journal: AgentSessionJournal, id: string): Promise<void> {
  await journal.appendItem(
    { provider: 'orca', clientMessageId: id },
    { kind: 'status', text: id },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

describe('the background-task roster on subscriber frames', () => {
  it('a pane resuming from its cursor drops a task that ended while it was away (#24227)', async () => {
    const journal = await openJournal('resume')
    let roster: AgentSessionBackgroundTaskState | null = MONITORING
    const subscribers = new AgentSessionSubscribers({ readBackgroundTasks: () => roster })
    let pane: StructuredAgentSessionState = EMPTY_STRUCTURED_AGENT_SESSION
    const toPane = (event: AgentSessionSubscribeEvent): void => {
      pane = reduceStructuredAgentSession(pane, { type: 'event', event })
    }

    const close = subscribers.open({
      id: 'pane-1',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit: toPane
    })
    expect(pane.backgroundTasks).toEqual(MONITORING)
    close()
    roster = null
    subscribers.republishBackgroundTasks(SESSION, 1)
    await appendRow(journal, 'after')
    subscribers.publish(SESSION, journal)

    subscribers.open({
      id: 'pane-2',
      sessionId: SESSION,
      journal,
      fence: 1,
      cursor: pane.cursor!,
      emit: toPane
    })

    expect(pane.backgroundTasks).toBeNull()
  })
})
