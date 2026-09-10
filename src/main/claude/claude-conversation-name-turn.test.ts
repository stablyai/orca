import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { startClaudeConversationNaming } from './claude-conversation-name-turn'
import type { ClaudeSession } from './claude-structured-session-state'

const SESSION = 'session-1'

const USER_TURN = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'fix the flaky lease probe' }]
} as unknown as AgentJournalMessageItem

function sessionWith(generateSessionTitle: ReturnType<typeof vi.fn>): ClaudeSession {
  return {
    namingAttempted: false,
    connection: { generateSessionTitle }
  } as unknown as ClaudeSession
}

/** Lets the fire-and-forget promise chain settle. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve()
  }
}

describe('startClaudeConversationNaming', () => {
  it('asks the CLI to generate and persist a title, then reports it', async () => {
    const generateSessionTitle = vi.fn(async () => ({
      outcome: 'named' as const,
      title: 'Lease probe flake'
    }))
    const session = sessionWith(generateSessionTitle)
    const onConversationName = vi.fn()

    startClaudeConversationNaming(SESSION, session, USER_TURN, { onConversationName })
    await settle()

    // `persist` is what writes the ai-title record a later attach reads back;
    // without it the name would live only in this process.
    expect(generateSessionTitle).toHaveBeenCalledWith(
      'fix the flaky lease probe',
      expect.objectContaining({ persist: true })
    )
    expect(onConversationName).toHaveBeenCalledExactlyOnceWith(SESSION, 'Lease probe flake')
  })

  it('leaves the attempt unspent when the first message carries no text', async () => {
    const generateSessionTitle = vi.fn(async () => ({
      outcome: 'named' as const,
      title: 'Lease probe flake'
    }))
    const session = sessionWith(generateSessionTitle)
    const imageOnly = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'image', path: '/tmp/shot.png' }]
    } as unknown as AgentJournalMessageItem

    startClaudeConversationNaming(SESSION, session, imageOnly, { onConversationName: vi.fn() })
    await settle()

    expect(generateSessionTitle).not.toHaveBeenCalled()
    // The conversation must stay nameable: a caption-free screenshot is not an
    // answer, so the next message with text still gets to ask.
    expect(session.namingAttempted).toBe(false)

    const onConversationName = vi.fn()
    startClaudeConversationNaming(SESSION, session, USER_TURN, { onConversationName })
    await settle()

    expect(onConversationName).toHaveBeenCalledExactlyOnceWith(SESSION, 'Lease probe flake')
  })

  it('passes the user text alone, imposing no title style of its own', async () => {
    const generateSessionTitle = vi.fn(async () => ({
      outcome: 'named' as const,
      title: 'Lease probe flake'
    }))

    startClaudeConversationNaming(SESSION, sessionWith(generateSessionTitle), USER_TURN, {
      onConversationName: vi.fn()
    })
    await settle()

    // Claude's own titling is a short noun phrase; instructing it in Codex's
    // imperative-verb style here would fight the SDK's own prompt.
    expect(generateSessionTitle).toHaveBeenCalledWith(
      'fix the flaky lease probe',
      expect.anything()
    )
  })

  it('asks only once across a re-acquisition, which builds a NEW session object', async () => {
    const generateSessionTitle = vi.fn(async () => ({ outcome: 'declined' as const }))
    // Passing the same object twice could only prove the in-memory flag; an
    // eviction hands the next send a fresh session, which is the real case.
    let attempted = false
    const deps = {
      onConversationName: vi.fn(),
      readNamingState: () => ({ conversationName: null, namingAttempted: attempted }),
      markNamingAttempted: () => {
        attempted = true
      }
    }

    startClaudeConversationNaming(SESSION, sessionWith(generateSessionTitle), USER_TURN, deps)
    await settle()
    startClaudeConversationNaming(SESSION, sessionWith(generateSessionTitle), USER_TURN, deps)
    await settle()

    expect(generateSessionTitle).toHaveBeenCalledOnce()
  })

  it('reports nothing when the title request answers null', async () => {
    const onConversationName = vi.fn()

    startClaudeConversationNaming(
      SESSION,
      sessionWith(vi.fn(async () => ({ outcome: 'declined' as const }))),
      USER_TURN,
      {
        onConversationName
      }
    )
    await settle()

    expect(onConversationName).not.toHaveBeenCalled()
  })

  it('keeps a failed title request off the turn', async () => {
    const onConversationName = vi.fn()
    const generateSessionTitle = vi.fn(async () => {
      throw new Error('claude generate_session_title request timed out')
    })

    expect(() =>
      startClaudeConversationNaming(SESSION, sessionWith(generateSessionTitle), USER_TURN, {
        onConversationName
      })
    ).not.toThrow()
    await settle()

    expect(onConversationName).not.toHaveBeenCalled()
  })

  it('does nothing when the submission carries no text to title', async () => {
    const generateSessionTitle = vi.fn(async () => ({ outcome: 'named' as const, title: 'x' }))

    startClaudeConversationNaming(
      SESSION,
      sessionWith(generateSessionTitle),
      { kind: 'message', role: 'user', blocks: [] } as unknown as AgentJournalMessageItem,
      { onConversationName: vi.fn() }
    )
    await settle()

    expect(generateSessionTitle).not.toHaveBeenCalled()
  })
})

describe('startClaudeConversationNaming robustness', () => {
  it('never fails the send when the title request throws synchronously', async () => {
    const onConversationName = vi.fn()
    // The control surface always exposes the method, so this shape is one the
    // types forbid — it stands in for any synchronous throw on the send path,
    // which is what actually turned a delivered message into a reported failure.
    const session = { namingAttempted: false, connection: {} } as unknown as ClaudeSession

    expect(() =>
      startClaudeConversationNaming(SESSION, session, USER_TURN, { onConversationName })
    ).not.toThrow()
    await settle()

    expect(onConversationName).not.toHaveBeenCalled()
  })
})

describe('startClaudeConversationNaming across re-acquisitions', () => {
  it('does not retitle a conversation the record already names', async () => {
    const generateSessionTitle = vi.fn(async () => ({
      outcome: 'named' as const,
      title: 'A second, different title'
    }))
    // Claude rebuilds its session on every acquisition, so this fresh object is
    // exactly what an evict-then-reacquire hands the next send.
    const reacquired = sessionWith(generateSessionTitle)

    startClaudeConversationNaming(SESSION, reacquired, USER_TURN, {
      onConversationName: vi.fn(),
      readNamingState: () => ({ conversationName: 'Lease probe flake', namingAttempted: true })
    })
    await settle()

    expect(generateSessionTitle).not.toHaveBeenCalled()
  })

  it('still names a conversation the record has never named', async () => {
    const generateSessionTitle = vi.fn(async () => ({
      outcome: 'named' as const,
      title: 'Lease probe flake'
    }))
    const onConversationName = vi.fn()

    startClaudeConversationNaming(SESSION, sessionWith(generateSessionTitle), USER_TURN, {
      onConversationName,
      readNamingState: () => ({ conversationName: null, namingAttempted: false })
    })
    await settle()

    expect(onConversationName).toHaveBeenCalledExactlyOnceWith(SESSION, 'Lease probe flake')
  })
})

describe('startClaudeConversationNaming host failures stay askable', () => {
  function attemptTracker() {
    let attempted = false
    return {
      deps: (generateSessionTitle: ReturnType<typeof vi.fn>) => ({
        onConversationName: vi.fn(),
        readNamingState: () => ({ conversationName: null, namingAttempted: attempted }),
        markNamingAttempted: () => {
          attempted = true
        },
        session: sessionWith(generateSessionTitle)
      }),
      wasAttempted: () => attempted
    }
  }

  it('does NOT mark a CLI that has no title request, so an upgrade can still name it', async () => {
    const tracker = attemptTracker()
    const generateSessionTitle = vi.fn(async () => ({ outcome: 'unsupported' as const }))
    const { session, ...deps } = tracker.deps(generateSessionTitle)

    startClaudeConversationNaming(SESSION, session, USER_TURN, deps)
    await settle()

    // Marking here would forfeit naming for every conversation started on that
    // build, permanently, even after the user upgrades.
    expect(tracker.wasAttempted()).toBe(false)
  })

  it('does NOT mark when the request itself failed', async () => {
    const tracker = attemptTracker()
    const generateSessionTitle = vi.fn(async () => {
      throw new Error('claude generate_session_title request timed out')
    })
    const { session, ...deps } = tracker.deps(generateSessionTitle)

    startClaudeConversationNaming(SESSION, session, USER_TURN, deps)
    await settle()

    expect(tracker.wasAttempted()).toBe(false)
  })

  it('DOES mark a model that answered without a title', async () => {
    const tracker = attemptTracker()
    const generateSessionTitle = vi.fn(async () => ({ outcome: 'declined' as const }))
    const { session, ...deps } = tracker.deps(generateSessionTitle)

    startClaudeConversationNaming(SESSION, session, USER_TURN, deps)
    await settle()

    expect(tracker.wasAttempted()).toBe(true)
  })
})

describe('Claude naming result ownership', () => {
  it.each([
    { conversationName: 'My manual name', namingAttempted: false },
    { conversationName: null, namingAttempted: true }
  ])('preserves a name or clear published during generation: %j', async (changed) => {
    let complete!: (value: { outcome: 'named'; title: string }) => void
    let current = { conversationName: null as string | null, namingAttempted: false }
    const generate = vi.fn(
      () =>
        new Promise<{ outcome: 'named'; title: string }>((resolve) => {
          complete = resolve
        })
    )
    const onConversationName = vi.fn()
    startClaudeConversationNaming(SESSION, sessionWith(generate), USER_TURN, {
      readNamingState: () => current,
      onConversationName
    })
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce())
    current = changed
    complete({ outcome: 'named', title: 'Generated replacement' })
    await settle()
    expect(onConversationName).not.toHaveBeenCalled()
  })

  it('uses the effective persisted title when a CLI manual rename races generation', async () => {
    const generate = vi.fn(async () => ({
      outcome: 'named' as const,
      title: 'Generated replacement'
    }))
    const onConversationName = vi.fn()
    startClaudeConversationNaming(SESSION, sessionWith(generate), USER_TURN, {
      onConversationName,
      readTranscriptConversationName: async () => ({ kind: 'named', title: 'My CLI name' })
    })
    await vi.waitFor(() => expect(onConversationName).toHaveBeenCalledWith(SESSION, 'My CLI name'))
    expect(onConversationName).not.toHaveBeenCalledWith(SESSION, 'Generated replacement')
  })

  it('waits for acquisition metadata before deciding whether generation is needed', async () => {
    let complete!: (value: { kind: 'named'; title: string }) => void
    const generate = vi.fn(async () => ({
      outcome: 'named' as const,
      title: 'Generated replacement'
    }))
    const session = sessionWith(generate)
    session.conversationNameRead = new Promise((resolve) => {
      complete = resolve
    })
    startClaudeConversationNaming(SESSION, session, USER_TURN, { onConversationName: vi.fn() })
    await settle()
    expect(generate).not.toHaveBeenCalled()
    complete({ kind: 'named', title: 'Existing CLI name' })
    await settle()
    expect(generate).not.toHaveBeenCalled()
  })
})
