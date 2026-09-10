import { describe, expect, it } from 'vitest'
import {
  ClaudeStructuredSessionAdapter,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-adapter'
import { claudeSessionIdForOrcaSession } from './claude-structured-launch-resolution'
import type { openClaudeStreamJsonConnection } from './claude-stream-json-connection'
import {
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID,
  tick
} from './claude-structured-session-test-support'

const sessionId = 'forked-orca-session'
const childId = claudeSessionIdForOrcaSession(sessionId)
const fork = {
  source: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: 'latest' },
  throughId: 'selected',
  retainedItemIds: [`claude:${PROVIDER_SESSION_ID}:selected`]
} as const

function initFrame(named: string): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    session_id: named,
    uuid: 'init-uuid',
    model: 'claude-sonnet-5'
  }
}

/**
 * The real CLI does not promise a transcript frame before the `initialize` reply, and the fake's
 * built-in `initProof` only ever emits one before it. `announceAfterReply` emits from `get_settings`
 * instead — the next control call the acquisition makes, i.e. strictly after the reply was observed
 * and after the init deadline was cleared.
 */
function setup(
  options: {
    initProof?: 'none'
    initSessionId?: string
    announceAfterReply?: string
  } = {}
) {
  const fake = fakeClaude({
    initSessionId: options.initSessionId ?? childId,
    ...(options.initProof ? { initProof: options.initProof } : {})
  })
  const events: ClaudeStructuredSessionEvent[] = []
  const announced = options.announceAfterReply
  const openConnection: typeof openClaudeStreamJsonConnection =
    announced === undefined
      ? fake.openConnection
      : async (launch, handlers = {}) => {
          const connection = await fake.openConnection(launch, handlers)
          const settings = connection.getSettings
          connection.getSettings = async (settingsOptions) => {
            handlers.onMessage?.(initFrame(announced))
            return settings(settingsOptions)
          }
          return connection
        }
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: { resume: PROVIDER_SESSION_ID },
      cwd: '/workspace',
      claudeConfigDir: '/account',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: 'latest',
      resumed: true
    }),
    onEvent: (event) => events.push(event),
    openConnection,
    readProcessStartTime: async () => 123
  })
  return { fake, adapter, events }
}

/** `forkSupport` answers `supported` exactly when the adapter still indexes a live session. */
function live(adapter: ClaudeStructuredSessionAdapter): boolean {
  return adapter.forkSupport(sessionId).supported
}

function acquireFork(adapter: ClaudeStructuredSessionAdapter) {
  return adapter.acquire({
    identity: identityFor(sessionId),
    fence: 1,
    spawnToken: 'child-token',
    fork
  })
}

describe('Claude fork acquisition', () => {
  it('opens a fork without requiring a lazily created child transcript', async () => {
    const { fake, adapter } = setup({ initProof: 'none' })
    try {
      const acquired = await acquireFork(adapter)
      expect(acquired.link.handle).toEqual({
        provider: 'claude',
        sessionId: childId,
        leafUuid: 'selected'
      })
      expect(fake.connections[0]?.sent).toEqual([])
      expect(fake.connections[0]?.launch.options).toMatchObject({
        forkSession: true,
        resume: PROVIDER_SESSION_ID,
        resumeSessionAt: 'selected',
        sessionId: childId
      })
    } finally {
      await adapter.closeSession(sessionId)
    }
  })

  // The published identity must not depend on whether the CLI got a frame out before its reply.
  it.each([
    { name: 'no init frame at all', options: { initProof: 'none' as const } },
    { name: 'an init frame before the initialize reply', options: {} },
    { name: 'an init frame after the initialize reply', options: { announceAfterReply: childId } }
  ])('publishes the requested child identity with $name', async ({ options }) => {
    const { adapter } = setup(options)
    try {
      const acquired = await acquireFork(adapter)
      expect(acquired.link.handle).toEqual({
        provider: 'claude',
        sessionId: childId,
        leafUuid: 'selected'
      })
    } finally {
      await adapter.closeSession(sessionId)
    }
  })

  it('closes a child that announces an unexpected provider identity', async () => {
    const { fake, adapter } = setup({ initSessionId: PROVIDER_SESSION_ID })
    await expect(acquireFork(adapter)).rejects.toThrow()
    expect(fake.connections[0]?.closed).toBe(true)
  })

  // The ordering the real CLI actually uses: the initialize reply wins, so the init deadline is
  // already cleared and nothing is awaiting its rejection when the foreign frame lands.
  it('refuses a foreign identity announced after the initialize reply', async () => {
    const { fake, adapter } = setup({
      initProof: 'none',
      announceAfterReply: 'a-different-session'
    })
    await expect(acquireFork(adapter)).rejects.toThrow('a-different-session')
    expect(fake.connections[0]?.closed).toBe(true)
    expect(live(adapter)).toBe(false)
  })

  it('ends a published forked session loudly when the CLI later names another identity', async () => {
    const { fake, adapter, events } = setup({ initProof: 'none' })
    try {
      await acquireFork(adapter)
      expect(live(adapter)).toBe(true)

      fake.connections[0]?.handlers.onMessage?.(initFrame('a-different-session'))
      await tick()
      await adapter.drainObservedExits()

      // Without this the frame filter would quarantine every later frame in silence.
      expect(live(adapter)).toBe(false)
      expect(fake.connections[0]?.closed).toBe(true)
      expect(events.filter((event) => event.type === 'ended')).toEqual([
        expect.objectContaining({
          type: 'ended',
          sessionId,
          cause: 'unexpected-exit',
          reason: expect.stringContaining('a-different-session')
        })
      ])
    } finally {
      await adapter.closeSession(sessionId)
    }
  })
})
