import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { ClaudeAgentViewBridge } from './agent-view-bridge'
import { CLAUDE_AGENT_VIEW_MOD_SOURCE } from './agent-view-mod-source'

const paneKey = 'tab:11111111-1111-4111-8111-111111111111'
const bindings = (chord: string) =>
  JSON.stringify({
    bindings: [{ context: 'Chat', bindings: { [chord]: 'command:orca-agent-view' } }]
  })

type Event = {
  isInteractive?: boolean
  surface?: string
  sessionId?: string
  reason?: string
  props?: { view: { agentId?: string } }
}
type Hook = (api: unknown, event: Event, next: () => Promise<object>) => Promise<unknown>
type On = (name: string, matcher: object | Hook, hook?: Hook) => void

function fixture(legacy = false) {
  const bridge = new ClaudeAgentViewBridge()
  const handlers = new Map<string, Hook>()
  const register: (on: On) => void = runInNewContext(
    `${CLAUDE_AGENT_VIEW_MOD_SOURCE.replace('export function register', 'function register')}\nregister`
  )
  register((name, matcher, hook) => {
    if (typeof matcher === 'function') {
      handlers.set(name, matcher)
    } else if (hook) {
      handlers.set(name, hook)
    }
  })
  const state = {
    sessionId: 'session',
    keybindings: bindings('ctrl+alt+g'),
    generation: 0,
    viewed: undefined as { agentId?: string } | undefined
  }
  const posts: { action: string; sessionId: string }[] = []
  const api = {
    env: {
      get: async (key: string) =>
        ({
          ORCA_PANE_KEY: paneKey,
          ORCA_AGENT_HOOK_ENDPOINT: '/test/endpoint.env',
          CLAUDE_CONFIG_DIR: '/test/.claude'
        })[key]
    },
    fs: {
      read: async (path: string) =>
        path.endsWith('keybindings.json')
          ? state.keybindings
          : `ORCA_AGENT_HOOK_PORT=1234\nORCA_AGENT_HOOK_TOKEN=test-token\nORCA_AGENT_HOOK_ENV=production\nORCA_AGENT_HOOK_VERSION=1\nORCA_AGENT_HOOK_GENERATION=${state.generation}\n`
    },
    session: { id: async () => state.sessionId },
    clock: {
      now: async () => Date.now(),
      every: (ms: number, callback: () => Promise<unknown>) => {
        const timer = setInterval(() => void callback(), ms)
        return { cancel: () => clearInterval(timer) }
      }
    },
    command: { register: async () => {} },
    ui: {
      view: async (view: { agentId?: string }) => {
        state.viewed = view
        return {}
      }
    },
    http: {
      fetch: async (_url: string, options: { body: string }) => {
        const body = JSON.parse(options.body)
        posts.push(body)
        const reply = bridge.receive(body)
        if (legacy) delete reply.lifecycle
        return { ok: true, text: JSON.stringify(reply) }
      }
    }
  }
  const invoke = async (name: string, event: Event = {}) => {
    const hook = handlers.get(name)
    if (!hook) throw new Error(`Missing hook: ${name}`)
    return hook(api, event, async () => ({}))
  }
  const render = async (agentId?: string) => {
    await invoke('ui.render', { surface: 'terminal', props: { view: { agentId } } })
    await vi.advanceTimersByTimeAsync(0)
  }
  const start = async () => {
    await invoke('session.start', { isInteractive: true, surface: 'terminal' })
    await render()
  }
  const view = (agentId?: string, chord = '\u001b[103;7u') =>
    bridge.view({
      paneKey,
      sessionId: state.sessionId,
      agentId,
      trigger: async (input, isCurrent) => {
        expect(input).toBe(chord)
        expect(isCurrent()).toBe(true)
        await invoke('command.run')
        return true
      }
    })
  return { bridge, api, state, posts, start, render, invoke, view }
}

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

// Guards the measured idle agent-view heartbeat incident in the idle-agent-view lane.
it('sends no unchanged registrations during idle and still delivers views and changed bindings', async () => {
  vi.useFakeTimers()
  const app = fixture()
  await app.start()
  const baseline = app.posts.length
  await vi.advanceTimersByTimeAsync(600_000)
  expect(app.posts.length - baseline).toBe(0)
  expect(await app.view('child')).toEqual({ status: 'viewed' })
  expect(app.state.viewed).toEqual({ agentId: 'child' })
  await app.render('child')

  app.state.keybindings = bindings('ctrl+alt+h')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await app.view(undefined, '\u001b[104;7u')).toEqual({ status: 'viewed' })

  app.state.keybindings = '{"bindings":[]}'
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await app.view('child')).toEqual({ status: 'unsupported' })
  app.state.keybindings = bindings('ctrl+alt+g')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await app.view()).toEqual({ status: 'viewed' })

  app.bridge.clear()
  app.state.generation++
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await app.view()).toEqual({ status: 'viewed' })
})

it('renews registrations only for an older runtime that still needs a lease', async () => {
  vi.useFakeTimers()
  const app = fixture(true)
  await app.start()
  const baseline = app.posts.length
  await vi.advanceTimersByTimeAsync(20_000)
  expect(app.posts.length - baseline).toBe(4)
  expect(await app.view('child')).toEqual({ status: 'viewed' })
})

it('rejects a command already in flight at clear and registers the next session on render', async () => {
  vi.useFakeTimers()
  const app = fixture()
  await app.start()
  const fetch = app.api.http.fetch
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let taken = () => {}
  const started = new Promise<void>((resolve) => {
    taken = resolve
  })
  app.api.http.fetch = async (url, options) => {
    const reply = await fetch(url, options)
    if (JSON.parse(options.body).action === 'take') {
      taken()
      await held
    }
    return reply
  }
  const command = app.view('child')
  await started
  await app.invoke('session.end', { sessionId: 'session', reason: 'clear' })
  release()
  expect(await command).toEqual({ status: 'unavailable' })
  expect(app.state.viewed).toBeUndefined()
  app.state.sessionId = 'after-clear'
  await app.render()
  expect(await app.view('child')).toEqual({ status: 'viewed' })
})
