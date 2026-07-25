import { describe, expect, it, vi } from 'vitest'
import {
  resolveAcpCommand,
  subscribeNativeChatAcpSession,
  type AcpChatSubscription
} from './acp-source'
import { readNativeChatSessionTail } from './source-dispatch'
import type { AcpClient } from '../acp/acp-stdio-client'

/** A scriptable ACP client: lets a test drive session updates and lifecycle
 *  without spawning an agent. */
function createFakeClient() {
  let onSessionUpdate: ((u: Record<string, unknown>, s: string | null) => void) | undefined
  let onExit: ((code: number | null, signal: string | null) => void) | undefined
  const calls: string[] = []
  let loadRejects = false
  let initializeRejects = false

  const client: AcpClient = {
    initialize: async () => {
      calls.push('initialize')
      if (initializeRejects) {
        throw new Error('ENOENT')
      }
      return { protocolVersion: 1 }
    },
    newSession: async () => {
      calls.push('newSession')
      return 'fresh-session'
    },
    loadSession: async () => {
      calls.push('loadSession')
      if (loadRejects) {
        throw new Error('unknown session')
      }
    },
    prompt: async () => ({}),
    cancel: () => calls.push('cancel'),
    request: async () => ({}),
    dispose: () => calls.push('dispose'),
    disposed: false
  }

  return {
    calls,
    failLoad: () => {
      loadRejects = true
    },
    failInitialize: () => {
      initializeRejects = true
    },
    emitUpdate: (update: Record<string, unknown>) => onSessionUpdate?.(update, 'sess'),
    emitExit: (code: number | null) => onExit?.(code, null),
    factory: ((options: {
      onSessionUpdate: (u: Record<string, unknown>, s: string | null) => void
      onExit?: (code: number | null, signal: string | null) => void
    }) => {
      onSessionUpdate = options.onSessionUpdate
      onExit = options.onExit
      return client
    }) as never
  }
}

const CHUNK = {
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: 'hello' }
}

async function subscribe(fake: ReturnType<typeof createFakeClient>, overrides = {}) {
  const onAppend = vi.fn()
  const onInitialSnapshot = vi.fn()
  const subscription = await subscribeNativeChatAcpSession({
    agent: 'hermes',
    sessionId: 'sess',
    onAppend,
    onInitialSnapshot,
    createClient: fake.factory,
    ...overrides
  })
  return { subscription, onAppend, onInitialSnapshot }
}

describe('resolveAcpCommand', () => {
  it('maps the ACP agents to their stdio subcommands', () => {
    expect(resolveAcpCommand('hermes')).toEqual({ command: 'hermes', args: ['acp'] })
    // omherm presents to Orca as agent type `omp`.
    expect(resolveAcpCommand('omp')).toEqual({ command: 'omp', args: ['acp'] })
  })

  it('returns null for transcript agents and unknown ids', () => {
    expect(resolveAcpCommand('claude')).toBeNull()
    expect(resolveAcpCommand('codex')).toBeNull()
    expect(resolveAcpCommand('nonesuch')).toBeNull()
    expect(resolveAcpCommand(null)).toBeNull()
  })
})

describe('subscribeNativeChatAcpSession', () => {
  it('initializes, resumes the named session, and reports watching', async () => {
    const fake = createFakeClient()
    const { subscription, onInitialSnapshot } = await subscribe(fake)
    expect(fake.calls).toEqual(['initialize', 'loadSession'])
    expect(subscription.watching).toBe(true)
    expect(onInitialSnapshot).toHaveBeenCalledWith([], false, 0)
  })

  it('opens a fresh session when the named one cannot be loaded', async () => {
    const fake = createFakeClient()
    fake.failLoad()
    const { subscription } = await subscribe(fake)
    expect(fake.calls).toEqual(['initialize', 'loadSession', 'newSession'])
    expect(subscription.watching).toBe(true)
  })

  it('delivers replayed history in the initial snapshot, not as an append', async () => {
    const fake = createFakeClient()
    const onAppend = vi.fn()
    const onInitialSnapshot = vi.fn()
    // Emit during loadSession, mimicking session/load's immediate replay.
    const subscription = await subscribeNativeChatAcpSession({
      agent: 'hermes',
      sessionId: 'sess',
      onAppend,
      onInitialSnapshot,
      createClient: ((options: {
        onSessionUpdate: (u: Record<string, unknown>, s: string | null) => void
      }) => {
        const build = fake.factory as unknown as (o: unknown) => AcpClient
        const real = build(options)
        return {
          ...real,
          loadSession: async () => {
            options.onSessionUpdate(CHUNK, 'sess')
          }
        }
      }) as never
    })

    expect(onAppend).not.toHaveBeenCalled()
    const [messages] = onInitialSnapshot.mock.calls[0]
    expect(messages).toHaveLength(1)
    expect(messages[0].source).toBe('acp')
    subscription.unsubscribe()
  })

  it('appends live updates once the snapshot has been delivered', async () => {
    const fake = createFakeClient()
    const { onAppend } = await subscribe(fake)
    fake.emitUpdate(CHUNK)
    expect(onAppend).toHaveBeenCalledOnce()
    const [messages] = onAppend.mock.calls[0]
    expect(messages[0].blocks[0]).toEqual({ type: 'text', text: 'hello' })
  })

  it('ignores updates that decode to nothing', async () => {
    const fake = createFakeClient()
    const { onAppend } = await subscribe(fake)
    fake.emitUpdate({ sessionUpdate: 'current_mode_update' })
    expect(onAppend).not.toHaveBeenCalled()
  })

  it('surfaces a startup failure in the view instead of a blank pane', async () => {
    const fake = createFakeClient()
    fake.failInitialize()
    const { subscription, onInitialSnapshot } = await subscribe(fake)
    expect(subscription.watching).toBe(false)
    expect(onInitialSnapshot).toHaveBeenCalledWith(
      [],
      false,
      0,
      expect.stringContaining('ACP agent unavailable')
    )
    expect(fake.calls).toContain('dispose')
  })

  it('marks the turn interrupted when the agent dies mid-conversation', async () => {
    const fake = createFakeClient()
    const { onAppend } = await subscribe(fake)
    fake.emitUpdate(CHUNK)
    onAppend.mockClear()
    fake.emitExit(1)
    expect(onAppend).toHaveBeenCalledWith([], expect.objectContaining({ state: 'interrupted' }))
  })

  it('disposes the client on unsubscribe, once', async () => {
    const fake = createFakeClient()
    const { subscription } = await subscribe(fake)
    subscription.unsubscribe()
    subscription.unsubscribe()
    expect(fake.calls.filter((c) => c === 'dispose')).toHaveLength(1)
  })

  it('stops emitting after unsubscribe', async () => {
    const fake = createFakeClient()
    const { subscription, onAppend } = await subscribe(fake)
    subscription.unsubscribe()
    fake.emitUpdate(CHUNK)
    expect(onAppend).not.toHaveBeenCalled()
  })

  it('refuses an agent that does not serve ACP', async () => {
    const onInitialSnapshot = vi.fn()
    const subscription = await subscribeNativeChatAcpSession({
      agent: 'claude',
      sessionId: 'sess',
      onAppend: () => {},
      onInitialSnapshot
    })
    expect(subscription.watching).toBe(false)
    expect(onInitialSnapshot).toHaveBeenCalledWith([], false, 0, 'Agent does not serve ACP')
  })
})

describe('readNativeChatSessionTail', () => {
  it('returns an empty window for ACP agents — history arrives via replay', async () => {
    // hasMore false keeps the client's "nothing older to load" path intact.
    await expect(
      readNativeChatSessionTail({ agent: 'hermes', sessionId: 's', limit: 300 })
    ).resolves.toEqual({ messages: [], hasMore: false, beforeOffset: 0 })
    await expect(
      readNativeChatSessionTail({ agent: 'omp', sessionId: 's', limit: 300 })
    ).resolves.toEqual({ messages: [], hasMore: false, beforeOffset: 0 })
  })
})

describe('ACP send path', () => {
  it('sends operator text as a prompt addressed to the agent session', async () => {
    const prompts: { sessionId: string; blocks: unknown[] }[] = []
    const fake = createFakeClient()
    const onAppend = vi.fn()
    const subscription = await subscribeNativeChatAcpSession({
      agent: 'hermes',
      sessionId: 'sess',
      onAppend,
      onInitialSnapshot: () => {},
      createClient: ((options: {
        onSessionUpdate: (u: Record<string, unknown>, s: string | null) => void
      }) => {
        const build = fake.factory as unknown as (o: unknown) => AcpClient
        const real = build(options)
        return {
          ...real,
          prompt: async (sessionId: string, blocks: unknown[]) => {
            prompts.push({ sessionId, blocks })
            return {}
          }
        }
      }) as never
    })

    await (subscription as AcpChatSubscription).sendPrompt('do the thing')
    expect(prompts).toEqual([
      { sessionId: 'sess', blocks: [{ type: 'text', text: 'do the thing' }] }
    ])
  })

  it('echoes the operator message immediately — agents need not replay it', async () => {
    const fake = createFakeClient()
    const onAppend = vi.fn()
    const subscription = await subscribeNativeChatAcpSession({
      agent: 'hermes',
      sessionId: 'sess',
      onAppend,
      onInitialSnapshot: () => {},
      createClient: fake.factory
    })

    await (subscription as AcpChatSubscription).sendPrompt('hello agent')
    const [messages] = onAppend.mock.calls[0]
    expect(messages[0].role).toBe('user')
    expect(messages[0].blocks[0]).toEqual({ type: 'text', text: 'hello agent' })
    expect(messages[0].source).toBe('acp')
  })

  it('addresses prompts to the fresh session id when load failed', async () => {
    const prompts: string[] = []
    const fake = createFakeClient()
    fake.failLoad()
    const subscription = await subscribeNativeChatAcpSession({
      agent: 'hermes',
      sessionId: 'stale-id',
      onAppend: () => {},
      onInitialSnapshot: () => {},
      createClient: ((options: {
        onSessionUpdate: (u: Record<string, unknown>, s: string | null) => void
      }) => {
        const build = fake.factory as unknown as (o: unknown) => AcpClient
        const real = build(options)
        return {
          ...real,
          prompt: async (sessionId: string) => {
            prompts.push(sessionId)
            return {}
          }
        }
      }) as never
    })

    await (subscription as AcpChatSubscription).sendPrompt('x')
    // Not the stale id the view asked for — the one session/new returned.
    expect(prompts).toEqual(['fresh-session'])
  })

  it('rejects a prompt after unsubscribe instead of writing to a dead client', async () => {
    const fake = createFakeClient()
    const { subscription } = await subscribe(fake)
    subscription.unsubscribe()
    await expect((subscription as AcpChatSubscription).sendPrompt('x')).rejects.toThrow(
      'not ready'
    )
  })

  it('rejects a prompt when the agent never started', async () => {
    const fake = createFakeClient()
    fake.failInitialize()
    const { subscription } = await subscribe(fake)
    await expect((subscription as AcpChatSubscription).sendPrompt('x')).rejects.toThrow(
      'unavailable'
    )
  })

  it('cancels the in-flight turn, and is inert once disposed', async () => {
    const fake = createFakeClient()
    const { subscription } = await subscribe(fake)
    ;(subscription as AcpChatSubscription).cancelTurn()
    expect(fake.calls).toContain('cancel')

    subscription.unsubscribe()
    const before = fake.calls.filter((c) => c === 'cancel').length
    ;(subscription as AcpChatSubscription).cancelTurn()
    expect(fake.calls.filter((c) => c === 'cancel')).toHaveLength(before)
  })
})
