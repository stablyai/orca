import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

import type {
  AgentSessionBackgroundTaskState,
  AgentSessionSlashCommand,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { createStructuredAgentSessionEventCoalescer } from '../../../shared/agent-session/structured-agent-session-coalescer'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { identityFor } from '../../claude/claude-structured-session-test-support'

it('delivers catalog changes through existing frames without resending them on ordinary output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-command-publication-'))
  const journals = createTrackedJournalOpener()
  const events: AgentSessionSubscribeEvent[] = []
  let state = EMPTY_STRUCTURED_AGENT_SESSION
  const coalescer = createStructuredAgentSessionEventCoalescer((event) => {
    events.push(event)
    state = reduceStructuredAgentSession(state, { type: 'event', event })
  })
  try {
    const journal = await journals.open({ identity: identityFor(), stateDirectory: root })
    const sessionId = identityFor().sessionId
    let commands: AgentSessionSlashCommand[] | undefined = [
      { name: 'loaded', kind: 'command', kindUnspecified: true }
    ]
    let roster: AgentSessionBackgroundTaskState | null = null
    const subscribers = new AgentSessionSubscribers({
      readCommands: () => commands,
      readBackgroundTasks: () => roster
    })
    const republishRoster = (): void => {
      roster = roster ? null : { state: 'monitoring' }
      subscribers.republishBackgroundTasks(sessionId, 7)
    }
    const close = subscribers.open({
      id: 'one',
      sessionId,
      journal,
      fence: 7,
      emit: coalescer.push
    })
    expect(state.commands).toEqual(commands)
    for (let i = 0; i < 25; i++) {
      republishRoster()
    }
    coalescer.flush()
    expect(events.filter((event) => 'commands' in event)).toHaveLength(1)
    commands = []
    subscribers.publish(sessionId, journal)
    republishRoster()
    coalescer.flush()
    expect(state.commands).toEqual([])
    expect(events.filter((event) => 'commands' in event)).toHaveLength(2)
    commands = undefined
    subscribers.publish(sessionId, journal)
    coalescer.flush()
    expect(state.commands).toBeNull()
    close()
    commands = [{ name: 'reconnected', kind: 'skill' }]
    subscribers.open({
      id: 'two',
      sessionId,
      journal,
      cursor: journal.cursor(),
      fence: 8,
      emit: coalescer.push
    })
    coalescer.flush()
    expect(state.commands).toEqual(commands)
    subscribers.snapshot(sessionId, journal, 8)
    expect(state.commands).toEqual(commands)
    commands = undefined
    subscribers.open({
      id: 'three',
      sessionId,
      journal,
      cursor: journal.cursor(),
      fence: 9,
      emit: coalescer.push
    })
    coalescer.flush()
    expect(state.commands).toBeNull()
  } finally {
    coalescer.dispose()
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  }
})
