/**
 * The renderer's own main process refused `agent.launch` while the same renderer aimed at a remote
 * host was admitted. This drives the registered `runtime:call` / `runtime:subscribe` handlers and
 * feeds what they actually advertise to the real host gate, so wiring and gate are proved together
 * rather than each against a restatement of the other.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../shared/protocol-version'

type AdvertisedClient = {
  clientKind?: 'mobile' | 'runtime'
  clientCapabilities?: readonly RuntimeCapability[]
}

const { handlers, advertised } = vi.hoisted(
  (): {
    handlers: Map<string, (event: unknown, args?: unknown) => unknown>
    advertised: { unary: AdvertisedClient[]; streaming: AdvertisedClient[] }
  } => ({
    handlers: new Map(),
    advertised: { unary: [], streaming: [] }
  })
)

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    removeHandler: vi.fn()
  }
}))

vi.mock('../runtime/rpc/dispatcher', () => ({
  RpcDispatcher: class {
    dispatch(_request: unknown, options: AdvertisedClient): Promise<unknown> {
      advertised.unary.push(options)
      return Promise.resolve({ ok: true, result: {} })
    }

    dispatchStreaming(
      _request: unknown,
      _emit: (response: string) => void,
      options: AdvertisedClient
    ): Promise<void> {
      advertised.streaming.push(options)
      // Never settles: the handler only attaches a cleanup callback to this.
      return new Promise<void>(() => {})
    }
  }
}))

const { registerRuntimeHandlers } = await import('./runtime')
const { supportsAgentLaunch } = await import('../runtime/rpc/methods/agent-launch')

function rendererEvent() {
  const mainFrame = {}
  return {
    sender: { id: 1, mainFrame, on: vi.fn(), once: vi.fn(), isDestroyed: () => false },
    senderFrame: mainFrame
  }
}

function invoke(channel: string, args: unknown): void {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`no handler registered for ${channel}`)
  }
  void handler(rendererEvent(), args)
}

/** Throws rather than defaulting: a missing record would make `supportsAgentLaunch` pass on the
 *  `clientKind === undefined` branch and every assertion below would be vacuous. */
function onlyAdvertisedClient(records: readonly AdvertisedClient[]): AdvertisedClient {
  const client = records[0]
  if (!client) {
    throw new Error('the handler dispatched nothing')
  }
  return client
}

function withoutLaunchCapability(client: AdvertisedClient): AdvertisedClient {
  return {
    clientKind: client.clientKind,
    clientCapabilities: client.clientCapabilities?.filter(
      (capability) => capability !== AGENT_LAUNCH_RUNTIME_CAPABILITY
    )
  }
}

describe('desktop renderer reaching agent.launch on its own main process', () => {
  beforeEach(() => {
    handlers.clear()
    advertised.unary.length = 0
    advertised.streaming.length = 0
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registerRuntimeHandlers reaches only the sender-lifecycle cleanup on this path; any other runtime method it called would throw here rather than read a wrong value.
    registerRuntimeHandlers({ cleanupSubscriptionsForConnection: vi.fn() } as never)
  })

  it('advertises the launch capability on the unary path', () => {
    invoke('runtime:call', {
      method: 'agent.launch',
      params: { agent: 'claude', target: { kind: 'existing', worktree: 'id:wt-7' } }
    })

    const client = onlyAdvertisedClient(advertised.unary)
    expect(client.clientKind).toBe('runtime')
    expect(supportsAgentLaunch(client)).toBe(true)
    // Negative control: the gate does refuse this same caller once the capability is taken away,
    // so the assertion above is about the advertised list, not a permissive predicate.
    expect(supportsAgentLaunch(withoutLaunchCapability(client))).toBe(false)
  })

  it('advertises the same set on the streaming path', () => {
    invoke('runtime:call', { method: 'status.get' })
    invoke('runtime:subscribe', { subscriptionId: 'sub-1', method: 'session.tabs.watch' })

    const streaming = onlyAdvertisedClient(advertised.streaming)
    expect(streaming.clientCapabilities).toEqual(
      onlyAdvertisedClient(advertised.unary).clientCapabilities
    )
    expect(supportsAgentLaunch(streaming)).toBe(true)
  })
})
