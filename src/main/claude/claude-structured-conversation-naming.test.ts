import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { ClaudeSessionTitle } from './claude-agent-sdk-control-requests'
import { ClaudeBackgroundTaskTracker } from './claude-background-task-tracker'
import { ClaudeSlashCommandCatalog } from './claude-slash-command-catalog'
import { ClaudeConversationNaming } from './claude-structured-conversation-naming'
import { resolveClaudeReplayWaiter } from './claude-structured-dispatch'
import type {
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps
} from './claude-structured-session-state'
import {
  acquired,
  fakeClaude,
  identityFor,
  USER_MESSAGE
} from './claude-structured-session-test-support'

type TitleCall = { description: string; persist: boolean | undefined }

function userMessage(blocks: AgentJournalMessageItem['blocks']): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks }
}

function sessionWith(
  titles: TitleCall[],
  respond: () => Promise<ClaudeSessionTitle>
): ClaudeSession {
  const session: ClaudeSession = {
    connection: null as unknown as ClaudeSession['connection'],
    providerSessionId: 'provider-session',
    claudeConfigDir: '/accounts/claude',
    leafUuid: null,
    fence: 1,
    acquisitionGeneration: 'generation-1',
    prompts: {} as ClaudeSession['prompts'],
    dispatchWaiters: [],
    retiredDispatchWaiters: [],
    replayContentFallbackBlocked: false,
    backgroundTasks: new ClaudeBackgroundTaskTracker(),
    commands: new ClaudeSlashCommandCatalog(),
    dispatchSequence: 0,
    optionMutationSequence: 0,
    options: new Map(),
    reportedOptions: {},
    reportedModelMutation: 0,
    confirmedOptions: new Set(),
    restoreSkippedOptions: new Set(),
    capabilities: [],
    events: undefined,
    translator: null
  }
  session.connection = {
    closed: false,
    send: async (message: Record<string, unknown>) => {
      // Echo the dispatch back as its own replay so the turn is admitted.
      resolveClaudeReplayWaiter(session, message)
    },
    generateSessionTitle: async (description: string, options?: { persist?: boolean }) => {
      titles.push({ description, persist: options?.persist })
      return respond()
    }
  } as unknown as ClaudeSession['connection']
  return session
}

function depsWith(
  stored: string[],
  storedName: string | null = null
): ClaudeStructuredSessionAdapterDeps {
  return {
    resolveLaunch: () => Promise.reject(new Error('unused')),
    readConversationName: () => storedName,
    storeConversationName: async (_sessionId, name) => {
      stored.push(name)
    }
  }
}

function dispatchInput(
  body: AgentJournalMessageItem = userMessage([{ type: 'text', text: 'ship' }])
) {
  return { sessionId: 'session-1', clientMessageId: 'client-1', body }
}

describe('Claude structured conversation naming', () => {
  it('stores the normalized title the provider generated', async () => {
    const titles: TitleCall[] = []
    const stored: string[] = []
    const naming = new ClaudeConversationNaming()
    const session = sessionWith(titles, async () => ({
      outcome: 'named',
      title: '  Fix\nthe   lease probe  '
    }))

    const outcome = await naming.dispatchTurn(
      depsWith(stored),
      session,
      dispatchInput(userMessage([{ type: 'text', text: 'fix the lease probe' }]))
    )
    await naming.drain()

    expect(outcome.state).toBe('admitted')
    expect(titles).toEqual([{ description: 'fix the lease probe', persist: true }])
    expect(stored).toEqual(['Fix the lease probe'])
  })

  it('stores nothing and never asks twice when the CLI has no title request', async () => {
    const titles: TitleCall[] = []
    const stored: string[] = []
    const naming = new ClaudeConversationNaming()
    const session = sessionWith(titles, async () => ({ outcome: 'unsupported' }))
    const deps = depsWith(stored)

    await naming.dispatchTurn(deps, session, dispatchInput())
    await naming.drain()
    await naming.dispatchTurn(deps, session, dispatchInput())
    await naming.drain()

    expect(titles).toHaveLength(1)
    expect(stored).toEqual([])
  })

  it('stores nothing when the provider declines to name the conversation', async () => {
    const titles: TitleCall[] = []
    const stored: string[] = []
    const naming = new ClaudeConversationNaming()
    const session = sessionWith(titles, async () => ({ outcome: 'declined' }))

    await naming.dispatchTurn(depsWith(stored), session, dispatchInput())
    await naming.drain()

    expect(titles).toHaveLength(1)
    expect(stored).toEqual([])
  })

  it('never asks again for a conversation an earlier session already named', async () => {
    const titles: TitleCall[] = []
    const stored: string[] = []
    const naming = new ClaudeConversationNaming()
    const session = sessionWith(titles, async () => ({ outcome: 'named', title: 'Second guess' }))

    await naming.dispatchTurn(depsWith(stored, 'Named last time'), session, dispatchInput())
    await naming.drain()

    expect(titles).toEqual([])
    expect(stored).toEqual([])
  })

  it('does not burn the attempt on a first message with no usable text', async () => {
    const titles: TitleCall[] = []
    const stored: string[] = []
    const naming = new ClaudeConversationNaming()
    const session = sessionWith(titles, async () => ({
      outcome: 'named',
      title: 'Screenshot review'
    }))
    const deps = depsWith(stored)

    await naming.dispatchTurn(
      deps,
      session,
      dispatchInput(userMessage([{ type: 'image-ref', url: 'https://example.test/shot.png' }]))
    )
    await naming.drain()
    expect(titles).toEqual([])

    await naming.dispatchTurn(deps, session, dispatchInput())
    await naming.drain()

    expect(titles).toEqual([{ description: 'ship', persist: true }])
    expect(stored).toEqual(['Screenshot review'])
  })

  it('keeps a turn admitted when the title request throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const titles: TitleCall[] = []
    const stored: string[] = []
    const naming = new ClaudeConversationNaming()
    const session = sessionWith(titles, () => Promise.reject(new Error('control request failed')))

    const outcome = await naming.dispatchTurn(depsWith(stored), session, dispatchInput())
    await expect(naming.drain()).resolves.toBeUndefined()

    expect(outcome.state).toBe('admitted')
    expect(stored).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('names the conversation from the adapter dispatch that the host calls', async () => {
    const stored: string[] = []
    const claude = fakeClaude({
      routes: { generate_session_title: () => ({ outcome: 'named', title: 'Ship it review' }) }
    })
    const adapter = await acquired(claude, {}, [], {
      readConversationName: () => null,
      storeConversationName: async (_sessionId, name) => {
        stored.push(name)
      }
    })

    const outcome = await adapter.dispatch({
      sessionId: identityFor().sessionId,
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })
    await adapter.drainConversationNaming()

    expect(outcome.state).toBe('admitted')
    expect(stored).toEqual(['Ship it review'])
    expect(claude.connections[0]?.calls).toContainEqual({
      subtype: 'generate_session_title',
      params: { description: 'ship it', persist: true }
    })
  })
})
