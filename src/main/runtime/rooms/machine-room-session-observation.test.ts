import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_ROOM_CONTEXT } from '../../../shared/rooms'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  type StructuredAgentSessionState
} from '../../../shared/structured-agent-session-reducer'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { roomStructuredLifecycle } from './machine-harness-session'
import {
  readMachineRoomContext,
  readMachineRoomStatus,
  subscribeMachineRoomSession
} from './machine-room-session-observation'

const binding = {
  transport: 'machine' as const,
  worktreeId: 'worktree-1',
  conversationId: 'session-1',
  providerSession: { key: 'session_id' as const, id: 'session-1', transport: 'machine' as const }
}

afterEach(() => setStructuredAgentSessionHost(null))

describe('machine room session observation', () => {
  it('does not report a restored journal as a live provider process', () => {
    setStructuredAgentSessionHost({ hasProviderChild: vi.fn(() => false) } as never)

    expect(readMachineRoomStatus(binding)).toEqual({
      handle: 'session-1',
      isRunningAgent: false,
      status: null
    })
  })

  it('replays a persisted terminal lifecycle without reopening the turn', () => {
    const state = stateWithItems([
      item(1, 'user', 'Room prompt'),
      item(2, 'assistant', 'ROOM_SMOKE_OK'),
      { ...lifecycle(3, 'completed', 'completed'), observedAt: 10, updatedAt: 40 }
    ])

    expect(roomStructuredLifecycle(state, true)).toMatchObject({
      type: 'final',
      turnId: 'turn-1',
      timestamp: 40,
      replay: true,
      userMessage: { id: 'turn-1', text: 'Room prompt' }
    })
  })

  it('does not turn a provider exit into a successful final', () => {
    const state = stateWithItems([
      item(1, 'user', 'Room prompt'),
      item(2, 'assistant', 'partial answer'),
      {
        itemId: 'exit-1',
        revision: 1,
        sequence: 3,
        observedAt: 30,
        body: { kind: 'status', text: 'Provider exited: connection lost' }
      },
      lifecycle(4, 'completed', 'failed')
    ])

    expect(roomStructuredLifecycle(state, true)).toMatchObject({
      type: 'failed',
      replay: true,
      turnId: 'turn-1'
    })
  })

  it('uses structured activity content instead of calling every active turn thinking', () => {
    const state = stateWithItems([
      lifecycle(1, 'running'),
      item(2, 'user', 'Room prompt'),
      item(3, 'reasoning', 'Considering'),
      item(4, 'assistant', 'Still working')
    ])

    expect(roomStructuredLifecycle(state)).toMatchObject({
      type: 'activity',
      turnId: 'turn-1',
      activity: { kind: 'working' },
      userMessage: { id: 'turn-1', text: 'Room prompt' }
    })
  })

  it('reports thinking before the provider emits visible response content', () => {
    const state = stateWithItems([lifecycle(1, 'running'), item(2, 'user', 'Room prompt')])

    expect(roomStructuredLifecycle(state)).toMatchObject({ activity: { kind: 'thinking' } })
  })

  it('keeps the active tool after a steer message in the same turn', () => {
    const state = stateWithItems([
      lifecycle(1, 'running'),
      item(2, 'user', 'Room prompt'),
      {
        itemId: 'command-1',
        revision: 1,
        sequence: 3,
        observedAt: 30,
        body: {
          kind: 'tool-call' as const,
          name: 'shell',
          input: { command: 'sleep 300' },
          state: 'running'
        }
      },
      item(4, 'user', 'Steer')
    ])

    expect(roomStructuredLifecycle(state)).toMatchObject({ activity: { kind: 'command' } })
  })

  it('uses the structured provider context when it is available', async () => {
    const context = { ...EMPTY_ROOM_CONTEXT, model: 'gpt-5.6-sol' }
    const history = vi.fn()
    setStructuredAgentSessionHost({ readContext: vi.fn(() => context), history } as never)

    await expect(readMachineRoomContext('codex', binding, EMPTY_ROOM_CONTEXT)).resolves.toBe(
      context
    )
    expect(history).not.toHaveBeenCalled()
  })

  it('keeps a running command active after partial output arrives', () => {
    const state = stateWithItems([
      lifecycle(1, 'running'),
      item(2, 'user', 'Room prompt'),
      {
        itemId: 'command-1',
        revision: 1,
        sequence: 3,
        observedAt: 30,
        body: {
          kind: 'tool-call' as const,
          name: 'shell',
          input: { command: 'sleep 300' },
          state: 'running',
          output: { head: 'started', byteLength: 7, truncated: false, digest: 'digest' }
        }
      }
    ])

    expect(roomStructuredLifecycle(state)).toMatchObject({ activity: { kind: 'command' } })
  })

  it('projects a stopped structured turn as interrupted', () => {
    const state = stateWithItems([
      item(1, 'user', 'Room prompt'),
      item(2, 'assistant', 'Partial answer'),
      lifecycle(3, 'completed', 'interrupted')
    ])

    expect(roomStructuredLifecycle(state)).toMatchObject({
      type: 'interrupted',
      turnId: 'turn-1',
      userMessage: { id: 'turn-1', text: 'Room prompt' }
    })
  })

  it('keeps a new turn separate from the stopped turn before it', () => {
    const state = stateWithItems([
      item(1, 'user', 'Old prompt'),
      item(2, 'assistant', 'Old partial answer'),
      lifecycle(3, 'completed', 'interrupted', 'old-turn'),
      lifecycle(4, 'running', undefined, 'new-turn'),
      item(5, 'user', 'New prompt')
    ])

    expect(roomStructuredLifecycle(state)).toMatchObject({
      type: 'activity',
      turnId: 'new-turn',
      userMessage: { id: 'new-turn', text: 'New prompt' },
      messages: []
    })
  })

  it('does not re-emit a terminal lifecycle when only the journal cursor advances', async () => {
    let emit: ((event: never) => void) | undefined
    setStructuredAgentSessionHost({
      hold: vi.fn(async () => undefined),
      release: vi.fn(),
      subscribe: vi.fn((input: { emit: (event: never) => void }) => {
        emit = input.emit
        return vi.fn()
      })
    } as never)
    const onEvent = vi.fn()
    await subscribeMachineRoomSession(binding, {
      onSnapshot: vi.fn(),
      onEvent,
      onOpaqueAppend: vi.fn()
    })
    const items = [
      item(1, 'user', 'Room prompt'),
      item(2, 'assistant', 'Partial answer'),
      lifecycle(3, 'completed', 'interrupted')
    ]
    emit?.({
      type: 'snapshot',
      sessionId: 'session-1',
      fence: 1,
      page: page(items, 3)
    } as never)
    emit?.({
      type: 'batch',
      sessionId: 'session-1',
      batch: {
        cursor: { epoch: 'epoch-1', sequence: 4 },
        items: [],
        removedItemIds: [],
        submissions: []
      }
    } as never)

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'interrupted', turnId: 'turn-1' })
    )
  })
})

function stateWithItems(items: StructuredAgentSessionState['items']): StructuredAgentSessionState {
  return { ...EMPTY_STRUCTURED_AGENT_SESSION, status: 'ready', items }
}

function item(sequence: number, role: 'user' | 'assistant' | 'reasoning', text: string) {
  return {
    itemId: `item-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence * 10,
    body: { kind: 'message' as const, role, blocks: [{ type: 'text' as const, text }] }
  }
}

function lifecycle(
  sequence: number,
  state: 'running' | 'completed',
  outcome?: 'completed' | 'failed' | 'interrupted',
  turnId = 'turn-1'
) {
  return {
    itemId: `lifecycle-${turnId}`,
    revision: sequence,
    sequence,
    observedAt: sequence * 10,
    body: {
      kind: 'status' as const,
      text: state === 'running' ? 'Working' : 'Interrupted',
      turnLifecycle: { turnId, state, ...(outcome ? { outcome } : {}) }
    }
  }
}

function page(items: StructuredAgentSessionState['items'], sequence: number) {
  const cursor = { epoch: 'epoch-1', sequence }
  return {
    sessionId: 'session-1',
    epoch: 'epoch-1',
    direction: 'tail' as const,
    items,
    removedItemIds: [],
    submissions: [],
    window: { oldest: { epoch: 'epoch-1', sequence: 1 }, newest: cursor, nextCursor: cursor },
    liveCursor: cursor,
    hasOlder: false,
    hasNewer: false
  }
}
