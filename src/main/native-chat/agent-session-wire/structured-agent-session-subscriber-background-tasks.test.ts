// The strip's roster rides each subscriber's frames: stated on its first frame and on every
// hydrating frame, re-sent when it differs from what that subscriber last got, and never read for
// an ordinary journal batch.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type {
  AgentSessionBackgroundTaskState,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../shared/structured-agent-session-reducer'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'

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

function rosterOf(event: AgentSessionSubscribeEvent | undefined) {
  return event && event.type !== 'end' ? event.backgroundTasks : undefined
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
    // The pane is hidden; the task ends with nobody listening, and the turn keeps journaling.
    close()
    roster = null
    subscribers.republishBackgroundTasks(SESSION, 1)
    await appendRow(journal, 'after')
    subscribers.publish(SESSION, journal)

    // The idle sweep stopped the provider; the pane comes back from its cursor.
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

  it('states the roster on a caught-up resume, which carries no rows', async () => {
    const journal = await openJournal('caught-up')
    const subscribers = new AgentSessionSubscribers({ readBackgroundTasks: () => MONITORING })
    const events: AgentSessionSubscribeEvent[] = []

    subscribers.open({
      id: 'pane',
      sessionId: SESSION,
      journal,
      fence: 1,
      cursor: journal.cursor(),
      emit: (event) => events.push(event)
    })

    expect(events).toHaveLength(1)
    expect(rosterOf(events[0])).toEqual(MONITORING)
  })

  it('carries the current roster on snapshot frames, so a running task stays shown', async () => {
    const journal = await openJournal('replay')
    const subscribers = new AgentSessionSubscribers({ readBackgroundTasks: () => MONITORING })
    const events: AgentSessionSubscribeEvent[] = []
    subscribers.open({
      id: 'pane',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit: (e) => events.push(e)
    })

    subscribers.snapshot(SESSION, journal, 2)

    expect(events.map((event) => [event.type, rosterOf(event)])).toEqual([
      ['snapshot', MONITORING],
      ['snapshot', MONITORING]
    ])
  })

  it('neither reads nor resends the roster for an ordinary journal batch', async () => {
    const journal = await openJournal('ordinary')
    const readBackgroundTasks = vi.fn(() => MONITORING)
    const subscribers = new AgentSessionSubscribers({ readBackgroundTasks })
    const events: AgentSessionSubscribeEvent[] = []
    subscribers.open({
      id: 'pane',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit: (e) => events.push(e)
    })
    const reads = readBackgroundTasks.mock.calls.length

    await appendRow(journal, 'token')
    subscribers.publish(SESSION, journal)

    expect(readBackgroundTasks).toHaveBeenCalledTimes(reads)
    expect(events.at(-1)).toMatchObject({ type: 'batch' })
    expect(rosterOf(events.at(-1))).toBeUndefined()
  })

  it('republishes to each subscriber whose last roster differs, and to no other', async () => {
    const journal = await openJournal('dedup')
    let roster: AgentSessionBackgroundTaskState | null = null
    const subscribers = new AgentSessionSubscribers({ readBackgroundTasks: () => roster })
    const first: AgentSessionSubscribeEvent[] = []
    const second: AgentSessionSubscribeEvent[] = []
    subscribers.open({
      id: 'first',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit: (e) => first.push(e)
    })

    roster = MONITORING
    subscribers.republishBackgroundTasks(SESSION, 1)
    // Opens holding the current roster already.
    subscribers.open({
      id: 'second',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit: (e) => second.push(e)
    })
    subscribers.republishBackgroundTasks(SESSION, 1)
    expect([first.length, second.length]).toEqual([2, 1])

    roster = null
    subscribers.republishBackgroundTasks(SESSION, 1)
    expect([rosterOf(first.at(-1)), rosterOf(second.at(-1))]).toEqual([null, null])
    expect([first.length, second.length]).toEqual([3, 2])
  })
})
