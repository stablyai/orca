import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import type {
  AgentSessionSubscribeEvent,
  AgentSessionTurnActivity
} from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

function journalItem(
  sequence: number,
  body: AgentJournalRenderItem['body']
): AgentJournalRenderItem {
  return { itemId: `item-${sequence}`, revision: 1, sequence, observedAt: sequence, body }
}

function snapshot(
  items: AgentJournalRenderItem[],
  fence: number,
  activity?: AgentSessionTurnActivity
): AgentSessionSubscribeEvent {
  const newest = items.length
  return {
    type: 'snapshot',
    sessionId: 'session-1',
    fence,
    ...(activity ? { activity } : {}),
    page: {
      sessionId: 'session-1',
      epoch: 'epoch-1',
      fence,
      direction: 'tail',
      items,
      removedItemIds: [],
      submissions: [],
      window: {
        oldest: { epoch: 'epoch-1', sequence: 1 },
        newest: { epoch: 'epoch-1', sequence: newest },
        nextCursor: { epoch: 'epoch-1', sequence: newest + 1 }
      },
      liveCursor: { epoch: 'epoch-1', sequence: newest },
      hasOlder: false,
      hasNewer: false
    }
  }
}

/** What the one live indicator row reads, resolved off the session journal. */
describe('useMobileStructuredAgentSession turn indicator', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
  let listener: ((value: unknown) => void) | null = null
  type RpcReply = { ok: boolean; result: unknown; _meta: { runtimeId: string } }
  const sendRequest = vi.fn(async (method: string): Promise<RpcReply> => ({
    ok: true,
    result:
      method === 'agentSession.options'
        ? {
            models: [{ id: 'gpt-fast', label: 'GPT Fast', isDefault: true, efforts: [] }],
            current: { model: 'gpt-fast' }
          }
        : {},
    _meta: { runtimeId: 'r1' }
  }))
  const subscribe = vi.fn((_method: string, _params: unknown, onData: (value: unknown) => void) => {
    listener = onData
    return vi.fn()
  })
  const client = { sendRequest, subscribe } as unknown as RpcClient
  // Stable across renders: a fresh callback would re-run the hold/subscribe effect
  // and release the session out from under the test.
  const onSendError = vi.fn()

  function Harness(): null {
    hook = useMobileStructuredAgentSession({
      client,
      sessionId: 'session-1',
      sourceIdentity: 'host-a\0workspace-a',
      enabled: true,
      connected: true,
      agent: 'codex',
      onSendError
    } as never)
    return null
  }

  beforeEach(() => {
    vi.clearAllMocks()
    listener = null
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
  })

  const runningTurn = journalItem(1, { kind: 'turn', turnId: 'turn-1', state: 'running' })
  const reasoning = journalItem(2, {
    kind: 'message',
    role: 'reasoning',
    blocks: [{ type: 'text', text: 'Weighing two approaches' }]
  })

  it('reads the live turn as reasoning while reasoning is its newest content', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).not.toBeNull())

    act(() => {
      listener?.(snapshot([runningTurn, reasoning], 3))
    })

    expect(hook?.turnIndicator).toEqual({
      thinking: true,
      activityText: null,
      stopping: false,
      stopRequestInFlight: false
    })
  })

  it('hands the row the provider copy once real content ends the reasoning', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).not.toBeNull())

    act(() => {
      listener?.(
        snapshot(
          [
            runningTurn,
            reasoning,
            journalItem(3, {
              kind: 'tool-call',
              name: 'shell',
              input: { command: 'pnpm lint' },
              state: 'running'
            }),
            journalItem(4, { kind: 'status', text: 'Context compacted' })
          ],
          3,
          { turnId: 'turn-1', text: 'Updating the plan' }
        )
      )
    })

    expect(hook?.turnIndicator).toEqual({
      thinking: false,
      activityText: 'Updating the plan',
      stopping: false,
      stopRequestInFlight: false
    })
  })

  it("reads Stopping from this phone's own Stop until its request answers", async () => {
    const passthrough = sendRequest.getMockImplementation()!
    type Reply = Awaited<ReturnType<typeof passthrough>>
    let answer: (value: Reply) => void = () => undefined
    // The Stop's request stays in flight until the test answers it; every other call is as usual.
    sendRequest.mockImplementation((method: string) =>
      method === 'agentSession.cancel'
        ? new Promise<Reply>((resolve) => (answer = resolve))
        : passthrough(method)
    )
    onTestFinished(() => {
      sendRequest.mockImplementation(passthrough)
    })
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).not.toBeNull())
    act(() => {
      listener?.(snapshot([runningTurn], 3))
    })
    expect(hook?.turnIndicator.stopping).toBe(false)

    act(() => hook?.cancel())
    // This host does not queue sends: a message sent now is held by the host until the stop lands.
    expect(hook?.turnIndicator).toMatchObject({
      stopping: true,
      stopRequestInFlight: true,
      afterStop: 'send'
    })

    await act(async () => {
      const cancelled = { ok: true, value: { cancelled: true } }
      answer({ ok: true, result: cancelled, _meta: { runtimeId: 'r1' } })
    })
    await vi.waitFor(() => expect(hook?.turnIndicator.stopping).toBe(false))
  })

  it('never reads a journal status row as the live activity', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).not.toBeNull())

    act(() => {
      listener?.(
        snapshot(
          [
            runningTurn,
            journalItem(2, {
              kind: 'status',
              tone: 'warning',
              text: 'Claude hit a temporary problem and is retrying.'
            })
          ],
          3
        )
      )
    })

    expect(hook?.turnIndicator).toEqual({
      thinking: false,
      activityText: null,
      stopping: false,
      stopRequestInFlight: false
    })
  })
})

/** The phone's chat reads the host's "Stopping…" from the status stream the desktop chat reads. */
describe("useMobileStructuredAgentSession and the host's Stopping", () => {
  type RpcReply = { ok: boolean; result: unknown; _meta: { runtimeId: string } }
  let renderer: ReactTestRenderer | null = null
  let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
  let streams: Map<string, (value: unknown) => void>
  let cancelReply: ((reply: RpcReply) => void) | null
  let subscribe: ReturnType<typeof vi.fn>
  let client: RpcClient
  const onSendError = vi.fn()
  const runningTurn = journalItem(1, { kind: 'turn', turnId: 'turn-1', state: 'running' })

  function hostSays(sessionId: string, stopping: boolean): void {
    act(() =>
      streams.get('agentSession.subscribeStatus')?.({
        type: 'status',
        session: {
          sessionId,
          workspaceId: 'workspace-a',
          agent: 'codex',
          status: 'working',
          updatedAt: 1,
          ...(stopping ? { stopping: true } : {})
        }
      })
    )
  }

  let connected = true

  function Harness({ statusFeed }: { statusFeed: boolean }): null {
    hook = useMobileStructuredAgentSession({
      client,
      sessionId: 'session-1',
      sourceIdentity: 'host-a\0workspace-a',
      enabled: true,
      connected,
      hostSupport: {
        promptCancel: false,
        questionAnswers: false,
        queuedMessages: false,
        queuedCommands: false,
        queuedClear: false,
        quietRepeatedStop: false,
        statusFeed
      },
      agent: 'codex',
      onSendError
    })
    return null
  }

  async function mount(options: { statusFeed?: boolean } = {}) {
    act(() => {
      renderer = create(createElement(Harness, { statusFeed: options.statusFeed ?? true }))
    })
    await vi.waitFor(() => expect(streams.has('agentSession.subscribe')).toBe(true))
    act(() => streams.get('agentSession.subscribe')?.(snapshot([runningTurn], 3)))
  }

  beforeEach(() => {
    streams = new Map()
    cancelReply = null
    connected = true
    subscribe = vi.fn((method: string, _params: unknown, onData: (value: unknown) => void) => {
      streams.set(method, onData)
      return vi.fn()
    })
    const sendRequest = vi.fn((method: string): Promise<RpcReply> =>
      method === 'agentSession.cancel'
        ? new Promise<RpcReply>((resolve) => (cancelReply = resolve))
        : Promise.resolve({ ok: true, result: {}, _meta: { runtimeId: 'r1' } })
    )
    // A fresh client per test: the status stream is one per client for its life.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the session hook and its status feed call only these members here; a missing one would throw at once, never misread.
    client = {
      sendRequest,
      subscribe,
      getState: () => 'connected',
      onStateChange: () => () => {}
    } as unknown as RpcClient
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
  })

  it('reads Stopping from the host with no press of its own, and keeps Stop for a repeat', async () => {
    await mount()

    hostSays('session-1', true)

    expect(hook?.turnIndicator).toMatchObject({ stopping: true, stopRequestInFlight: false })
  })

  it("stays Stopping after this phone's own Stop answers while the host still says so", async () => {
    await mount()
    act(() => hook?.cancel())
    hostSays('session-1', true)
    expect(hook?.turnIndicator).toMatchObject({ stopping: true, stopRequestInFlight: true })

    await act(async () => {
      const cancelled = { ok: true, value: { cancelled: true } }
      cancelReply?.({ ok: true, result: cancelled, _meta: { runtimeId: 'r1' } })
    })

    await vi.waitFor(() => expect(hook?.turnIndicator.stopRequestInFlight).toBe(false))
    expect(hook?.turnIndicator.stopping).toBe(true)
  })

  it("never reads another session's Stopping", async () => {
    await mount()

    hostSays('session-2', true)

    expect(hook?.turnIndicator.stopping).toBe(false)
  })

  it('reads nothing from the host while the phone is not connected', async () => {
    await mount()
    hostSays('session-1', true)
    expect(hook?.turnIndicator.stopping).toBe(true)

    connected = false
    act(() => renderer?.update(createElement(Harness, { statusFeed: true })))

    expect(hook?.turnIndicator.stopping).toBe(false)
  })

  it('never opens the status stream on a host without the status feed', async () => {
    await mount({ statusFeed: false })

    expect(subscribe.mock.calls.map(([method]) => method)).not.toContain(
      'agentSession.subscribeStatus'
    )
    expect(hook?.turnIndicator.stopping).toBe(false)
  })
})
