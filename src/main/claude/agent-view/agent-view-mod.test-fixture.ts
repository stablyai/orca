import { runInNewContext } from 'node:vm'
import { expect, vi } from 'vitest'
import { ClaudeAgentViewBridge } from './agent-view-bridge'
import { CLAUDE_AGENT_VIEW_MOD_SOURCE } from './agent-view-mod-source'

export const paneKey = 'tab:11111111-1111-4111-8111-111111111111'
export const bindings = (chord: string) =>
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
type On = (
  name: string,
  matcher: { command: string } | { component: string } | Hook,
  hook?: Hook
) => void

export function fixture(legacy = false) {
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
  const state: {
    sessionId: string
    keybindings: string
    port: number
    token: string
    viewed?: { agentId?: string }
  } = {
    sessionId: 'session',
    keybindings: bindings('ctrl+alt+g'),
    port: 1234,
    token: 'test-token'
  }
  let legacySeenAt = -Infinity
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
          : `ORCA_AGENT_HOOK_PORT=${state.port}\nORCA_AGENT_HOOK_TOKEN=${state.token}\nORCA_AGENT_HOOK_ENV=production\nORCA_AGENT_HOOK_VERSION=1\n`
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
        if (legacy && Date.now() - legacySeenAt >= 15_000) {
          bridge.clear()
        }
        const reply = legacy && body.action === 'renew' ? {} : bridge.receive(body)
        if (legacy) {
          delete reply.renew
          if (body.action === 'register' && reply.registered) {
            legacySeenAt = Date.now()
          }
        }
        return { ok: true, text: JSON.stringify(reply) }
      }
    }
  }
  const invoke = async (name: string, event: Event = {}) => {
    const hook = handlers.get(name)
    if (!hook) {
      throw new Error(`Missing hook: ${name}`)
    }
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
  const view = (agentId?: string, chord = '\u001b[103;7u') => {
    // An older main also drops a registration unrenewed for 15 seconds before viewing.
    if (legacy && Date.now() - legacySeenAt >= 15_000) {
      bridge.clear()
    }
    return bridge.view({
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
  }
  return { bridge, api, state, posts, start, render, invoke, view }
}
