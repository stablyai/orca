import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_CREATE_FORK_RUNTIME_CAPABILITY,
  AGENT_SESSION_CREATE_FORK_ORIGINAL_RUNTIME_CAPABILITY
} from '../../../../../src/shared/agent-session/agent-session-create-capabilities'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { AgentJournalRenderItem } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { useMobileNativeChatFork, type MobileNativeChatFork } from './use-mobile-native-chat-fork'

const renderers: ReactTestRenderer[] = []

afterEach(() => {
  act(() => renderers.forEach((renderer) => renderer.unmount()))
  renderers.length = 0
})

/** A connection whose agent-list reads fail as scripted (true = fails), as when the socket drops. */
function connection(failures: number | readonly boolean[]) {
  const listeners = new Set<(state: 'connected' | 'reconnecting') => void>()
  const script =
    typeof failures === 'number' ? Array.from({ length: failures }, () => true) : [...failures]
  let generation = 1
  const sendRequest = vi.fn(async () => {
    if (script.shift() === true) {
      throw new Error('Connection interrupted')
    }
    return {
      ok: true,
      result: { agents: [{ agent: 'claude', capabilities: { fork: 'checkpoint' } }] }
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only sendRequest, onStateChange and getGeneration from its client.
  const client = {
    sendRequest,
    getGeneration: () => generation,
    onStateChange: (listener: (state: 'connected' | 'reconnecting') => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  } as unknown as RpcClient
  const reconnect = () => listeners.forEach((listener) => listener('connected'))
  const migrate = () => {
    generation++
    reconnect()
  }
  return { client, sendRequest, reconnect, migrate }
}

const reply: AgentJournalRenderItem = {
  itemId: 'reply',
  sequence: 1,
  revision: 1,
  observedAt: 1,
  body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'ok' }] }
}
const message: NativeChatMessage = {
  id: 'reply',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'ok' }],
  timestamp: 1,
  source: 'transcript',
  journalPosition: { sequence: 1, index: 0 }
}
const FORK_HOST = [AGENT_SESSION_CREATE_FORK_RUNTIME_CAPABILITY]
let latest: MobileNativeChatFork | null = null

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

it('offers an inherited OpenCode tip after the child advances and submits its displayed key', async () => {
  let renderer!: ReactTestRenderer
  const { client, sendRequest } = connection(0)
  sendRequest.mockResolvedValue({
    ok: true,
    result: { agents: [{ agent: 'opencode', capabilities: { fork: 'tip' } }] }
  })
  const createFork = vi.fn(async () => {})
  const copied = {
    ...message,
    id: 'legacy:opencode:source:reply-1',
    journalPosition: { sequence: 5, index: 0 }
  }
  const copiedPrompt: NativeChatMessage = {
    ...message,
    id: 'legacy:opencode:source:user-1',
    role: 'user',
    journalPosition: { sequence: 4, index: 0 }
  }
  const ownPrompt: NativeChatMessage = {
    ...message,
    id: 'legacy:opencode:child:user-2',
    role: 'user',
    journalPosition: { sequence: 7, index: 0 }
  }
  const own = {
    ...message,
    id: 'legacy:opencode:child:reply-2',
    journalPosition: { sequence: 8, index: 0 }
  }
  const olderPrompt: NativeChatMessage = {
    ...copiedPrompt,
    id: 'legacy:opencode:source:user-0',
    journalPosition: { sequence: 1, index: 0 }
  }
  const older = {
    ...copied,
    id: 'legacy:opencode:source:reply-0',
    journalPosition: { sequence: 2, index: 0 }
  }
  function ForkProbe({
    hostCapabilities,
    hostStatusPending = false
  }: {
    hostCapabilities: readonly string[]
    hostStatusPending?: boolean
  }) {
    latest = useMobileNativeChatFork({
      client,
      hostCapabilities,
      hostStatusPending,
      agent: 'opencode',
      sessionId: 'child',
      messages: [olderPrompt, older, copiedPrompt, copied, ownPrompt, own],
      turnJournal: {
        items: [
          {
            ...reply,
            itemId: olderPrompt.id,
            sequence: 1,
            body: { kind: 'message', role: 'user', blocks: [] }
          },
          { ...reply, itemId: older.id, sequence: 2 },
          {
            ...reply,
            itemId: copiedPrompt.id,
            sequence: 4,
            body: { kind: 'message', role: 'user', blocks: copiedPrompt.blocks }
          },
          { ...reply, itemId: copied.id, sequence: 5 },
          {
            ...reply,
            itemId: 'orca:forked-from',
            sequence: 6,
            body: { kind: 'status', presentation: 'forked-from', text: 'Forked from source' }
          },
          {
            ...reply,
            itemId: ownPrompt.id,
            sequence: 7,
            body: { kind: 'message', role: 'user', blocks: ownPrompt.blocks }
          },
          { ...reply, itemId: own.id, sequence: 8 }
        ],
        submissions: []
      },
      agentWorking: false,
      sessionForkSupport: 'supported',
      createFork
    })
    return null
  }
  await act(async () => {
    renderer = create(createElement(ForkProbe, { hostCapabilities: FORK_HOST }))
    renderers.push(renderer)
  })
  await settle()
  expect(latest?.offerFor(copied)).toBe('reserved')
  expect(latest?.offerFor(older)).toBe('reserved')
  expect(latest?.offerFor(own)).toBe('available')
  await act(async () => {
    renderer.update(
      createElement(ForkProbe, {
        hostCapabilities: [...FORK_HOST, AGENT_SESSION_CREATE_FORK_ORIGINAL_RUNTIME_CAPABILITY]
      })
    )
  })
  expect(latest?.offerFor(copied)).toBe('available')
  expect(latest?.offerFor(older)).toBe('available')
  await act(async () => {
    renderer.update(
      createElement(ForkProbe, {
        hostCapabilities: [...FORK_HOST, AGENT_SESSION_CREATE_FORK_ORIGINAL_RUNTIME_CAPABILITY],
        hostStatusPending: true
      })
    )
  })
  expect(latest?.offerFor(copied)).toBe('reserved')
  expect(latest?.offerFor(own)).toBe('available')
  await act(async () => {
    renderer.update(
      createElement(ForkProbe, {
        hostCapabilities: [...FORK_HOST, AGENT_SESSION_CREATE_FORK_ORIGINAL_RUNTIME_CAPABILITY],
        hostStatusPending: false
      })
    )
  })
  expect(latest?.offerFor(copied)).toBe('available')
  await act(async () => {
    latest?.fork(copied)
  })
  expect(createFork).toHaveBeenCalledWith('opencode', {
    sessionId: 'child',
    throughItemId: 'legacy:opencode:source:reply-1'
  })
  await act(async () => {
    renderer.update(createElement(ForkProbe, { hostCapabilities: FORK_HOST }))
  })
  expect(latest?.offerFor(copied)).toBe('reserved')
})

it('still hands a chat it cannot copy to another agent as a recap', async () => {
  const { client } = connection(0)
  const run = vi.fn(async () => {})
  function ForkProbe() {
    latest = useMobileNativeChatFork({
      client,
      hostCapabilities: FORK_HOST,
      hostStatusPending: false,
      agent: 'claude',
      sessionId: 'chat',
      messages: [message],
      turnJournal: { items: [reply], submissions: [] },
      agentWorking: false,
      sessionForkSupport: 'unsupported',
      createFork: vi.fn(async () => {})
    })
    return null
  }
  await act(async () => {
    renderers.push(create(createElement(ForkProbe)))
  })
  await settle()
  expect(latest?.copyOffered()).toBe(false)
  expect(latest?.offerFor(message)).toBe('available')
  expect(latest?.forkWith(message, run, 'copy')).toBe(false)
  await act(async () => {
    expect(latest?.forkWith(message, run, 'recap')).toBe(true)
  })
  expect(run).toHaveBeenCalledWith('claude', { sessionId: 'chat', throughItemId: 'reply' })
})

it('offers Fork on each finished terminal reply, past the tool and hook rows that end its turn', async () => {
  const { client } = connection(0)
  const row = (
    id: string,
    role: NativeChatMessage['role'],
    blocks: NativeChatMessage['blocks']
  ) => ({
    id,
    role,
    blocks,
    timestamp: 1,
    source: 'transcript' as const
  })
  const text = (value: string) => [{ type: 'text' as const, text: value }]
  const call = [{ type: 'tool-call' as const, toolCallId: 't', name: 'TodoWrite', input: {} }]
  const result = [{ type: 'tool-result' as const, toolCallId: 't', content: 'ok' }]
  const messages: NativeChatMessage[] = [
    row('u1', 'user', text('fix it')),
    row('a1', 'assistant', text('Checking.')),
    row('c1', 'assistant', call),
    row('r1', 'tool', result),
    row('a2', 'assistant', text('Fixed.')),
    row('c2', 'assistant', call),
    row('r2', 'tool', result),
    row('u2', 'user', text('thanks')),
    row('a3', 'assistant', text('Anytime.')),
    row('s3', 'system', text('Stop hook feedback'))
  ]
  function ForkProbe({ agentWorking }: { agentWorking: boolean }) {
    latest = useMobileNativeChatFork({
      client,
      hostCapabilities: FORK_HOST,
      hostStatusPending: false,
      agent: 'claude',
      sessionId: 'terminal-session',
      messages,
      turnJournal: null,
      agentWorking,
      sessionForkSupport: 'supported',
      createFork: async () => {},
      terminal: true
    })
    return null
  }
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(createElement(ForkProbe, { agentWorking: false }))
    renderers.push(renderer)
  })
  expect(messages.map((entry) => latest?.offerFor(entry))).toEqual([
    'hidden',
    'reserved',
    'reserved',
    'hidden',
    'available',
    'reserved',
    'hidden',
    'hidden',
    'available',
    'hidden'
  ])
  await act(async () => {
    renderer.update(createElement(ForkProbe, { agentWorking: true }))
  })
  expect(latest?.offerFor(messages[4]!)).toBe('available')
  expect(latest?.offerFor(messages[8]!)).toBe('reserved')
})
