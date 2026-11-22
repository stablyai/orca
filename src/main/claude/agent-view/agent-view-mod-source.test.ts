import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { CLAUDE_AGENT_VIEW_MOD_SOURCE } from './agent-view-mod-source'

it('registers on change only, retries undelivered posts, and rejects in-flight commands after clear', async () => {
  type SessionEvent = {
    isInteractive?: boolean
    surface?: 'terminal'
    reason?: 'clear' | 'resume'
    sessionId?: string
    props?: { view: { agentId?: string } }
  }
  type Hook = (api: unknown, event: SessionEvent, next: () => Promise<object>) => Promise<unknown>
  type On = (
    event: string,
    matcherOrHook: { command: string } | { component: string } | Hook,
    hook?: Hook
  ) => void
  const handlers = new Map<string, Hook>()
  const register: (on: On) => void = runInNewContext(
    `${CLAUDE_AGENT_VIEW_MOD_SOURCE.replace(
      'export function register',
      'function register'
    )}\nregister`
  )
  register((event, matcherOrHook, hook) => {
    if (typeof matcherOrHook === 'function') {
      handlers.set(event, matcherOrHook)
    } else if (hook) {
      handlers.set(event, hook)
    }
  })
  let sessionId = 'session-before-clear'
  let registrationReply = JSON.stringify({ registered: true, durable: true })
  const timers: { ms: number; callback: () => Promise<unknown> }[] = []
  let pendingTake: Promise<void> | undefined
  let takeStarted: (() => void) | undefined
  const posts: {
    action: string
    sessionId: string
    instanceId: string
    view?: { agentId?: string; revision: number }
  }[] = []
  const view = vi.fn(async () => ({}))
  let now = 1_700_000_000_000
  const api = {
    env: {
      get: async (key: string) =>
        ({
          ORCA_PANE_KEY: 'tab:11111111-1111-4111-8111-111111111111',
          ORCA_AGENT_HOOK_PORT: '1234',
          ORCA_AGENT_HOOK_TOKEN: 'test-token',
          ORCA_CLAUDE_CONFIG_DIR: '/test/.claude',
          CLAUDE_CONFIG_DIR: '/test/actual-claude-config'
        })[key]
    },
    fs: {
      read: async () =>
        JSON.stringify({
          bindings: [
            {
              context: 'Chat',
              bindings: {
                'Alt+Control+G': 'command:orca-agent-view'
              }
            }
          ]
        })
    },
    session: { id: async () => sessionId },
    clock: {
      now: async () => now,
      every: () => {
        throw new Error('an idle Claude must not poll Orca')
      },
      after: (ms: number, callback: () => Promise<unknown>) => {
        timers.push({ ms, callback })
      }
    },
    command: { register: vi.fn() },
    ui: { view },
    http: {
      fetch: async (_url: string, options: { body: string }) => {
        const body = JSON.parse(options.body)
        posts.push(body)
        if (body.action === 'take') {
          takeStarted?.()
          await pendingTake
        }
        return {
          ok: true,
          text:
            body.action === 'register'
              ? registrationReply
              : JSON.stringify(
                  body.action === 'take'
                    ? {
                        requestId: 'request',
                        agentId: 'child',
                        expiresAt: now + 1000
                      }
                    : body.action === 'observe'
                      ? { observed: true }
                      : {}
                )
        }
      }
    }
  }
  const invoke = async (name: string, event: SessionEvent = {}) => {
    const handler = handlers.get(name)
    if (!handler) {
      throw new Error(`Missing handler: ${name}`)
    }
    return handler(api, event, async () => ({}))
  }
  const read = vi.spyOn(api.fs, 'read')
  await invoke('ui.render', { surface: 'terminal', props: { view: {} } })
  expect(posts).toHaveLength(0)
  await invoke('session.start', { isInteractive: true, surface: 'terminal' })
  await vi.waitFor(() =>
    expect(posts.at(-1)).toMatchObject({
      action: 'register',
      sessionId,
      configDir: '/test/actual-claude-config'
    })
  )
  expect(read).toHaveBeenCalledWith('/test/actual-claude-config/keybindings.json')
  expect(timers).toHaveLength(0)
  await invoke('ui.render', { surface: 'terminal', props: { view: {} } })
  await vi.waitFor(() =>
    expect(posts.at(-1)).toMatchObject({ action: 'observe', view: { revision: 1 } })
  )
  await invoke('ui.render', {
    surface: 'terminal',
    props: { view: { agentId: 'keyboard-child' } }
  })
  await vi.waitFor(() =>
    expect(posts.at(-1)).toMatchObject({
      action: 'observe',
      view: { agentId: 'keyboard-child', revision: 2 }
    })
  )
  const count = posts.length
  await invoke('ui.render', {
    surface: 'terminal',
    props: { view: { agentId: 'keyboard-child' } }
  })
  expect(posts).toHaveLength(count)
  await invoke('turn.start')
  expect(posts).toHaveLength(count)
  now += 30_000
  await invoke('turn.start')
  await vi.waitFor(() => expect(posts).toHaveLength(count + 1))
  expect(posts.at(-1)).toMatchObject({
    action: 'register',
    view: { agentId: 'keyboard-child', revision: 2 }
  })
  const firstInstance = posts.at(-1)?.instanceId
  let releaseTake = () => {}
  pendingTake = new Promise<void>((resolve) => {
    releaseTake = resolve
  })
  const started = new Promise<void>((resolve) => {
    takeStarted = resolve
  })
  const command = invoke('command.run')
  await started
  await invoke('session.end', { reason: 'clear', sessionId })
  releaseTake()
  await command
  expect(timers.map(({ ms }) => ms)).toEqual([1000])
  await timers.shift()?.callback()
  await invoke('turn.start')
  await invoke('command.run')
  expect(posts.at(-1)?.action).toBe('end')
  expect(view).not.toHaveBeenCalled()
  expect(posts.filter(({ action }) => action === 'ack')).toHaveLength(0)
  sessionId = 'session-after-clear'
  // Claude runs no mod session.start for /clear; the next turn announces the new session.
  await invoke('turn.start')
  await vi.waitFor(() => expect(posts.at(-1)).toMatchObject({ action: 'register', sessionId }))
  expect(posts.at(-1)?.instanceId).not.toBe(firstInstance)
  expect(posts.at(-1)?.view).toBeUndefined()
  await invoke('command.run')
  expect(view).toHaveBeenCalledWith({ agentId: 'child' })
  expect(posts.at(-1)).toMatchObject({ action: 'ack', sessionId })
  const fetch = api.http.fetch
  api.http.fetch = async () => {
    throw new Error('Orca is unavailable')
  }
  await expect(invoke('command.run')).resolves.toEqual({})
  await invoke('ui.render', {
    surface: 'terminal',
    props: { view: { agentId: 'offline-child' } }
  })
  await vi.waitFor(() => expect(timers.map(({ ms }) => ms)).toEqual([1000]))
  api.http.fetch = fetch
  registrationReply = ''
  await timers.shift()?.callback()
  expect(posts.at(-1)).toMatchObject({ action: 'register', view: { agentId: 'offline-child' } })
  expect(timers.map(({ ms }) => ms)).toEqual([2000])
  registrationReply = JSON.stringify({ registered: true })
  await timers.shift()?.callback()
  expect(posts.at(-1)).toMatchObject({ action: 'register', sessionId })
  expect(timers.map(({ ms }) => ms)).toEqual([5000])
  api.http.fetch = async () => new Promise(() => {})
  await expect(
    invoke('ui.render', { surface: 'terminal', props: { view: { agentId: 'another-child' } } })
  ).resolves.toEqual({})
  await expect(
    invoke('session.start', { isInteractive: true, surface: 'terminal' })
  ).resolves.toEqual({})
})
