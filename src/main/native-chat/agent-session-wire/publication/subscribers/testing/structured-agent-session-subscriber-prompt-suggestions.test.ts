import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeProviderHandle } from '../../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentSessionSubscribeEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../../../../shared/agent-session/view/live-read/structured-agent-session-reducer'
import type { AgentSessionJournal } from '../../../../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { AgentSessionSubscribers } from '../structured-agent-session-subscribers'

const SESSION = 'suggestion-session'
const SUGGESTION = { id: 'suggestion-1', text: 'add a test for it' }

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-subscriber-suggestion-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function openJournal(): Promise<AgentSessionJournal> {
  return journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('provider-1', null)
    },
    stateDirectory: join(root, 'journal')
  })
}

function reader(
  subscribers: AgentSessionSubscribers,
  journal: AgentSessionJournal,
  id: string,
  showsPromptSuggestions: boolean
) {
  const frames: AgentSessionSubscribeEvent[] = []
  let state: StructuredAgentSessionState = EMPTY_STRUCTURED_AGENT_SESSION
  const close = subscribers.open({
    id,
    sessionId: SESSION,
    journal,
    fence: 1,
    showsPromptSuggestions,
    emit: (event) => {
      frames.push(event)
      state = reduceStructuredAgentSession(state, { type: 'event', event })
    }
  })
  return { frames, close, state: () => state }
}

describe('prompt suggestions on subscriber frames', () => {
  it('reach only readers that show them, and the session wants them while one reads', async () => {
    const journal = await openJournal()
    const interest = vi.fn()
    const subscribers = new AgentSessionSubscribers({ onPromptSuggestionInterest: interest })
    const chat = reader(subscribers, journal, 'chat', true)
    const cli = reader(subscribers, journal, 'cli', false)
    expect(interest.mock.calls).toEqual([[SESSION, true]])

    subscribers.promptSuggestions.publish(SESSION, SUGGESTION)
    await vi.waitFor(() => expect(chat.state().promptSuggestion).toEqual(SUGGESTION))
    // A snapshot is journal state; the suggestion lives beside it.
    subscribers.snapshot(SESSION, journal, 1)
    const late = reader(subscribers, journal, 'late', true)
    await vi.waitFor(() => expect(late.state().promptSuggestion).toEqual(SUGGESTION))
    expect(chat.state().promptSuggestion).toEqual(SUGGESTION)

    subscribers.promptSuggestions.publish(SESSION, null)
    await vi.waitFor(() => expect(chat.state().promptSuggestion).toBeNull())
    expect(cli.frames.some((frame) => 'promptSuggestion' in frame)).toBe(false)

    chat.close()
    late.close()
    expect(interest.mock.calls).toEqual([
      [SESSION, true],
      [SESSION, false]
    ])
    cli.close()
  })
})
