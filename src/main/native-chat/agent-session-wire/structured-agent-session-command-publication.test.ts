import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type {
  AgentSessionSlashCommand,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { createStructuredAgentSessionEventCoalescer } from '../../../shared/structured-agent-session-coalescer'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from '../../claude/claude-structured-session-test-support'

it('publishes idle provider reloads only when the actual command catalog changes', async () => {
  const claude = fakeClaude()
  const adapter = adapterFor(claude)
  const publish = vi.fn()
  await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'commands',
    events: {
      appendItem: vi.fn(),
      appendTombstone: vi.fn(),
      publish
    }
  })
  publish.mockClear()
  const message = {
    type: 'system',
    subtype: 'commands_changed',
    session_id: PROVIDER_SESSION_ID,
    commands: [{ name: 'new-skill', description: '', argumentHint: '' }]
  }
  claude.connections[0].handlers.onMessage?.(message)
  expect(adapter.readCommands(identityFor().sessionId)).toEqual([
    { name: 'new-skill', kind: 'command', kindUnspecified: true }
  ])
  expect(publish).toHaveBeenCalledTimes(1)
  claude.connections[0].handlers.onMessage?.(message)
  expect(publish).toHaveBeenCalledTimes(1)
})

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
    const journal = await journals.open({ identity: identityFor(), journalDir: root })
    const sessionId = identityFor().sessionId
    let commands: AgentSessionSlashCommand[] | undefined = [
      { name: 'loaded', kind: 'command', kindUnspecified: true }
    ]
    const subscribers = new AgentSessionSubscribers({ readCommands: () => commands })
    const close = subscribers.open({
      id: 'one',
      sessionId,
      journal,
      fence: 7,
      emit: coalescer.push
    })
    expect(state.commands).toEqual(commands)
    for (let i = 0; i < 25; i++) {
      subscribers.handoff(sessionId, 7, {
        owner: 'none',
        direction: null,
        phase: 'idle',
        stage: null,
        operationId: null
      })
    }
    coalescer.flush()
    expect(events.filter((event) => 'commands' in event)).toHaveLength(1)
    commands = []
    subscribers.publish(sessionId, journal)
    subscribers.handoff(sessionId, 7, {
      owner: 'none',
      direction: null,
      phase: 'idle',
      stage: null,
      operationId: null
    })
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
    subscribers.reset(sessionId, journal, 'epoch_changed', 8)
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
