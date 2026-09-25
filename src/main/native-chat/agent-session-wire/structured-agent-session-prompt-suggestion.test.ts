import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createStructuredAgentSessionEventCoalescer } from '../../../shared/structured-agent-session-coalescer'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { identityFor } from '../../claude/claude-structured-session-test-support'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'

it('carries suggestions through idle checkpoints, coalescing, clearing and reconnect without journal rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-suggestions-'))
  const journals = createTrackedJournalOpener()
  let state = EMPTY_STRUCTURED_AGENT_SESSION
  const frames: AgentSessionSubscribeEvent[] = []
  const coalescer = createStructuredAgentSessionEventCoalescer((event) => {
    frames.push(event)
    state = reduceStructuredAgentSession(state, { type: 'event', event })
  })
  try {
    const journal = await journals.open({ identity: identityFor(), journalDir: root })
    const sessionId = identityFor().sessionId
    const originalCursor = journal.cursor()
    let promptSuggestion: string | null = 'Add tests'
    const subscribers = new AgentSessionSubscribers({
      readPromptSuggestion: () => promptSuggestion
    })
    const close = subscribers.open({
      id: 'one',
      sessionId,
      journal,
      fence: 7,
      emit: coalescer.push
    })
    expect(state.promptSuggestion).toBe('Add tests')
    promptSuggestion = 'Run tests'
    subscribers.publish(sessionId, journal)
    subscribers.handoff(sessionId, 7, {
      owner: 'none',
      direction: null,
      phase: 'idle',
      stage: null,
      operationId: null
    })
    coalescer.flush()
    expect(state.promptSuggestion).toBe('Run tests')
    promptSuggestion = null
    subscribers.publish(sessionId, journal)
    coalescer.flush()
    expect(state.promptSuggestion).toBeNull()
    const count = frames.length
    subscribers.publish(sessionId, journal)
    coalescer.flush()
    expect(frames).toHaveLength(count)
    close()
    promptSuggestion = 'Explain tests'
    subscribers.open({
      id: 'two',
      sessionId,
      journal,
      fence: 7,
      cursor: journal.cursor(),
      emit: coalescer.push
    })
    coalescer.flush()
    expect(state.promptSuggestion).toBe('Explain tests')
    expect(state.items).toEqual([])
    expect(journal.cursor()).toEqual(originalCursor)
    // An older host's reset omits the field and must discard stale text.
    new AgentSessionSubscribers().open({
      id: 'old',
      sessionId,
      journal,
      fence: 7,
      emit: coalescer.push
    })
    expect(state.promptSuggestion).toBeUndefined()
  } finally {
    coalescer.dispose()
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  }
})
