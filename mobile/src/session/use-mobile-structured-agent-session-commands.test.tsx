import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionSlashCommand,
  AgentSessionSubscribeEvent
} from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() }
}))

function snapshotEvent(): AgentSessionSubscribeEvent {
  return {
    type: 'snapshot',
    sessionId: 'session-1',
    fence: 3,
    page: {
      sessionId: 'session-1',
      epoch: 'epoch-1',
      fence: 3,
      direction: 'tail',
      items: [],
      removedItemIds: [],
      submissions: [],
      window: { oldest: null, newest: null, nextCursor: { epoch: 'epoch-1', sequence: 0 } },
      liveCursor: { epoch: 'epoch-1', sequence: 0 },
      hasOlder: false,
      hasNewer: false
    }
  }
}

describe('useMobileStructuredAgentSession `/` catalog', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
  let listener: ((value: unknown) => void) | null = null
  const client: RpcClient = {
    sendRequest: vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValue({ id: 'rpc', ok: true, result: {}, _meta: { runtimeId: 'runtime-1' } }),
    subscribe: (_method, _params, onData) => {
      listener = onData
      return () => {}
    },
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }

  function Harness(): null {
    hook = useMobileStructuredAgentSession({
      client,
      sessionId: 'session-1',
      sourceIdentity: 'host-a\0workspace-a',
      enabled: true,
      connected: true,
      hostSupport: null,
      agent: 'claude',
      onSendError: vi.fn()
    })
    return null
  }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
    listener = null
  })

  it('exposes the `/` menu inputs and keeps their reference across unrelated frames', async () => {
    const reported: AgentSessionSlashCommand[] = [
      { name: 'review', kind: 'command', description: 'Review a PR' },
      { name: 'triage', kind: 'skill' }
    ]
    const batch = (
      sequence: number,
      commands?: AgentSessionSlashCommand[] | null
    ): AgentSessionSubscribeEvent => ({
      type: 'batch',
      sessionId: 'session-1',
      batch: {
        cursor: { epoch: 'epoch-1', sequence },
        items: [],
        removedItemIds: [],
        submissions: []
      },
      ...(commands !== undefined ? { commands } : {})
    })
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    // Defined before any report or options load, so the menu shows the structured fallback.
    expect(hook?.slashCatalog).toEqual({ sessionCommands: undefined, conversationCommands: [] })

    act(() => listener?.({ ...snapshotEvent(), commands: reported }))
    expect(hook?.slashCatalog.sessionCommands).toEqual(reported)
    const held = hook?.slashCatalog
    // An unrelated frame omits the field: the lists the menu keys on keep their references.
    act(() => listener?.(batch(1)))
    expect(hook?.slashCatalog.sessionCommands).toBe(held?.sessionCommands)
    expect(hook?.slashCatalog.conversationCommands).toBe(held?.conversationCommands)

    const refreshed: AgentSessionSlashCommand[] = [...reported, { name: 'init', kind: 'command' }]
    act(() => listener?.(batch(2, refreshed)))
    expect(hook?.slashCatalog.sessionCommands).toEqual(refreshed)
    act(() => listener?.(batch(3, [])))
    expect(hook?.slashCatalog.sessionCommands).toEqual([])
    act(() => listener?.(batch(4, null)))
    expect(hook?.slashCatalog.sessionCommands).toBeUndefined()

    act(() => listener?.({ ...snapshotEvent(), commands: reported }))
    expect(hook?.slashCatalog.sessionCommands).toEqual(reported)
    // A snapshot or reset without the field replaces the catalog, as an older host would.
    act(() => listener?.(snapshotEvent()))
    expect(hook?.slashCatalog.sessionCommands).toBeUndefined()
  })
})
