import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { CLAUDE_TERMINAL_MAIL_PATH } from '../../../shared/claude-agent-view'
import { CLAUDE_AGENT_VIEW_MOD_SOURCE } from './agent-view-mod-source'

type Hook = (api: unknown, event: object, next: () => Promise<object>) => Promise<unknown>
type On = (
  event: string,
  matcherOrHook: Hook | { command: string } | { component: string },
  hook?: Hook
) => void

it('submits polled orchestration mail as a prompt of its own and acknowledges it', async () => {
  const handlers = new Map<string, Hook>()
  const register: (on: On) => void = runInNewContext(
    `${CLAUDE_AGENT_VIEW_MOD_SOURCE.replace('export function register', 'function register')}\nregister`
  )
  register((event, matcherOrHook, hook) => {
    const handler = typeof matcherOrHook === 'function' ? matcherOrHook : hook
    if (handler) {
      handlers.set(event, handler)
    }
  })
  const timers: { ms: number; tick: () => Promise<unknown> }[] = []
  const posts: { url: string; body: Record<string, unknown> }[] = []
  const submit = vi.fn(async () => ({ text: 'ok' }))
  const api = {
    // No Claude config dir: the agent view stays off, mail still flows.
    env: {
      get: async (key: string) =>
        ({
          ORCA_PANE_KEY: 'tab:11111111-1111-4111-8111-111111111111',
          ORCA_AGENT_HOOK_PORT: '1234',
          ORCA_AGENT_HOOK_TOKEN: 'test-token'
        })[key]
    },
    session: { id: async () => 'session-1' },
    clock: {
      now: async () => 1_700_000_000_000,
      every: (ms: number, tick: () => Promise<unknown>) => timers.push({ ms, tick })
    },
    prompt: { submit },
    http: {
      fetch: async (url: string, options: { body: string }) => {
        const body = JSON.parse(options.body)
        posts.push({ url, body })
        const reply =
          body.action === 'poll'
            ? { submissions: [{ id: 'sub-1', text: 'You have 1 message.' }] }
            : {}
        return { ok: true, text: JSON.stringify(reply) }
      }
    }
  }

  await handlers.get('session.start')?.(
    api,
    { isInteractive: true, surface: 'terminal' },
    async () => ({})
  )
  const mailTick = timers.find((timer) => timer.ms === 1000)
  await mailTick?.tick()

  expect(submit).toHaveBeenCalledWith({ text: 'You have 1 message.' })
  expect(
    posts.map(({ url, body }) => [url.endsWith(CLAUDE_TERMINAL_MAIL_PATH), body.action])
  ).toEqual([
    [true, 'poll'],
    [true, 'ack']
  ])
  expect(posts[1]?.body).toMatchObject({ id: 'sub-1', submitted: true, sessionId: 'session-1' })
})

it('hands back mail polled for a session that ended before it was submitted', async () => {
  const handlers = new Map<string, Hook>()
  const register: (on: On) => void = runInNewContext(
    `${CLAUDE_AGENT_VIEW_MOD_SOURCE.replace('export function register', 'function register')}\nregister`
  )
  register((event, matcherOrHook, hook) => {
    const handler = typeof matcherOrHook === 'function' ? matcherOrHook : hook
    if (handler) {
      handlers.set(event, handler)
    }
  })
  let sessionId = 'session-1'
  const timers: { ms: number; tick: () => Promise<unknown> }[] = []
  const acks: Record<string, unknown>[] = []
  const submit = vi.fn(async () => ({ text: 'ok' }))
  const api = {
    env: {
      get: async (key: string) =>
        ({
          ORCA_PANE_KEY: 'tab:11111111-1111-4111-8111-111111111111',
          ORCA_AGENT_HOOK_PORT: '1234',
          ORCA_AGENT_HOOK_TOKEN: 'test-token'
        })[key]
    },
    session: { id: async () => sessionId },
    clock: {
      now: async () => 1_700_000_000_000,
      every: (ms: number, tick: () => Promise<unknown>) => timers.push({ ms, tick })
    },
    prompt: { submit },
    http: {
      fetch: async (_url: string, options: { body: string }) => {
        const body = JSON.parse(options.body)
        if (body.action === 'ack') {
          acks.push(body)
        }
        // The session is cleared while the poll is in flight.
        sessionId = 'session-2'
        const reply = body.action === 'poll' ? { submissions: [{ id: 'sub-1', text: 'mail' }] } : {}
        return { ok: true, text: JSON.stringify(reply) }
      }
    }
  }

  await handlers.get('session.start')?.(
    api,
    { isInteractive: true, surface: 'terminal' },
    async () => ({})
  )
  await timers.find((timer) => timer.ms === 1000)?.tick()

  expect(submit).not.toHaveBeenCalled()
  expect(acks).toEqual([
    expect.objectContaining({ id: 'sub-1', submitted: false, sessionId: 'session-1' })
  ])
})

it('sends its end only after acking what the poll in flight took', async () => {
  const handlers = new Map<string, Hook>()
  const register: (on: On) => void = runInNewContext(
    `${CLAUDE_AGENT_VIEW_MOD_SOURCE.replace('export function register', 'function register')}\nregister`
  )
  register((event, matcherOrHook, hook) => {
    const handler = typeof matcherOrHook === 'function' ? matcherOrHook : hook
    if (handler) {
      handlers.set(event, handler)
    }
  })
  const timers: { ms: number; tick: () => Promise<unknown> }[] = []
  const mailPosts: string[] = []
  let ended: Promise<unknown> | undefined
  const api = {
    env: {
      get: async (key: string) =>
        ({
          ORCA_PANE_KEY: 'tab:11111111-1111-4111-8111-111111111111',
          ORCA_AGENT_HOOK_PORT: '1234',
          ORCA_AGENT_HOOK_TOKEN: 'test-token'
        })[key]
    },
    session: { id: async () => 'session-1' },
    clock: {
      now: async () => 1_700_000_000_000,
      every: (ms: number, tick: () => Promise<unknown>) => timers.push({ ms, tick })
    },
    prompt: { submit: vi.fn(async () => ({ text: 'ok' })) },
    http: {
      fetch: async (url: string, options: { body: string }) => {
        const body = JSON.parse(options.body)
        if (url.endsWith(CLAUDE_TERMINAL_MAIL_PATH)) {
          mailPosts.push(body.action)
        }
        if (body.action === 'poll') {
          // Claude's session ends while the poll is in flight.
          ended = handlers.get('session.end')?.(
            api,
            { sessionId: 'session-1', reason: 'clear' },
            async () => ({})
          )
          return {
            ok: true,
            text: JSON.stringify({ submissions: [{ id: 'sub-1', text: 'mail' }] })
          }
        }
        return { ok: true, text: '{}' }
      }
    }
  }

  await handlers.get('session.start')?.(
    api,
    { isInteractive: true, surface: 'terminal' },
    async () => ({})
  )
  await timers.find((timer) => timer.ms === 1000)?.tick()
  await ended
  await vi.waitFor(() => expect(mailPosts).toHaveLength(3))

  expect(mailPosts).toEqual(['poll', 'ack', 'end'])
})

it('acks polled mail as not submitted when the session id cannot be read', async () => {
  const handlers = new Map<string, Hook>()
  const register: (on: On) => void = runInNewContext(
    `${CLAUDE_AGENT_VIEW_MOD_SOURCE.replace('export function register', 'function register')}\nregister`
  )
  register((event, matcherOrHook, hook) => {
    const handler = typeof matcherOrHook === 'function' ? matcherOrHook : hook
    if (handler) {
      handlers.set(event, handler)
    }
  })
  const timers: { ms: number; tick: () => Promise<unknown> }[] = []
  const acks: Record<string, unknown>[] = []
  let reads = 0
  const submit = vi.fn(async () => ({ text: 'ok' }))
  const api = {
    env: {
      get: async (key: string) =>
        ({
          ORCA_PANE_KEY: 'tab:11111111-1111-4111-8111-111111111111',
          ORCA_AGENT_HOOK_PORT: '1234',
          ORCA_AGENT_HOOK_TOKEN: 'test-token'
        })[key]
    },
    // The poll reads the id once; the read before submitting fails.
    session: {
      id: async () => {
        reads += 1
        if (reads > 1) {
          throw new Error('session gone')
        }
        return 'session-1'
      }
    },
    clock: {
      now: async () => 1_700_000_000_000,
      every: (ms: number, tick: () => Promise<unknown>) => timers.push({ ms, tick })
    },
    prompt: { submit },
    http: {
      fetch: async (_url: string, options: { body: string }) => {
        const body = JSON.parse(options.body)
        if (body.action === 'ack') {
          acks.push(body)
        }
        const reply = body.action === 'poll' ? { submissions: [{ id: 'sub-1', text: 'mail' }] } : {}
        return { ok: true, text: JSON.stringify(reply) }
      }
    }
  }

  await handlers.get('session.start')?.(
    api,
    { isInteractive: true, surface: 'terminal' },
    async () => ({})
  )
  await timers.find((timer) => timer.ms === 1000)?.tick()

  expect(submit).not.toHaveBeenCalled()
  expect(acks).toEqual([expect.objectContaining({ id: 'sub-1', submitted: false })])
})
