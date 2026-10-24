import { afterEach, describe, expect, it, vi } from 'vitest'
import { SendParams } from '../../shared/rpc-contract/structured-agent-session-params'
import { parseChatSessionSelector } from '../chat-sessions'
import { RuntimeClientError } from '../runtime-client'
import { CHAT_HANDLERS } from './chat'

const SESSION = 'codex_8eb631ab_59c5_41e4_8672_01cfe0a6fd5f'
const HANDLE = `structured-agent-session-${SESSION}`

function ok(result: unknown) {
  return { id: 'req', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function agentRow(paneKey: string, overrides: Record<string, unknown> = {}) {
  return {
    paneKey,
    parentPaneKey: null,
    state: 'working',
    agentType: 'codex',
    prompt: '',
    taskTitle: null,
    displayName: 'Fix tests',
    lastAssistantMessage: 'Running the suite.',
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 1,
    updatedAt: 2,
    ...overrides
  }
}

function historyPage(
  items: unknown[],
  fence: number | undefined = 3,
  pageOverrides: Record<string, unknown> = {}
) {
  return ok({
    ok: true,
    page: {
      sessionId: SESSION,
      epoch: 'e',
      fence,
      direction: 'tail',
      items,
      removedItemIds: [],
      submissions: [],
      ...pageOverrides
    }
  })
}

function item(body: unknown) {
  return { itemId: 'i', revision: 1, sequence: 1, observedAt: 1, body }
}

function fakeClient(
  responses: unknown[],
  capabilities: string[] = ['agent-session.queued-messages.v1']
) {
  const call = vi.fn()
  for (const response of responses) {
    call.mockResolvedValueOnce(response)
  }
  return {
    call,
    getCliStatus: vi.fn(async () => ({
      result: { runtime: { reachable: true, runtimeId: 'runtime-1', capabilities } }
    }))
  }
}

async function run(command: string, flags: Record<string, string | boolean>, client: unknown) {
  const logs: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(line))
  try {
    await CHAT_HANDLERS[command]!({
      flags: new Map(Object.entries(flags)),
      client,
      cwd: '/tmp',
      json: true
    } as never)
  } finally {
    spy.mockRestore()
  }
  return JSON.parse(logs.join('\n')).result
}

afterEach(() => vi.restoreAllMocks())

describe('parseChatSessionSelector', () => {
  it('accepts a session id, a handle, or a pane key', () => {
    expect(parseChatSessionSelector(SESSION)).toBe(SESSION)
    expect(parseChatSessionSelector(HANDLE)).toBe(SESSION)
    expect(parseChatSessionSelector(`${HANDLE}:leaf-1`)).toBe(SESSION)
    expect(() => parseChatSessionSelector('structured-agent-session-')).toThrow(RuntimeClientError)
  })
})

describe('chat list', () => {
  it('lists top-level chats and leaves terminal agents and subagents out', async () => {
    const client = fakeClient([
      ok({
        worktrees: [
          {
            worktreeId: 'repo::/w',
            displayName: 'paper',
            agents: [
              agentRow(`${HANDLE}:leaf`),
              agentRow(`${HANDLE}:sub`, { parentPaneKey: `${HANDLE}:leaf` }),
              agentRow('tab-1:pane-1', { state: 'done' })
            ]
          }
        ]
      })
    ])
    const result = await run('chat list', {}, client)
    expect(result.chats).toEqual([
      expect.objectContaining({
        session: SESSION,
        handle: HANDLE,
        worktree: 'paper',
        state: 'working',
        title: 'Fix tests',
        lastAssistantMessage: 'Running the suite.'
      })
    ])
  })

  it('keeps only chats in the requested state', async () => {
    const client = fakeClient([
      ok({
        worktrees: [
          {
            worktreeId: 'repo::/w',
            displayName: 'paper',
            agents: [agentRow(`${HANDLE}:leaf`, { state: 'done' })]
          }
        ]
      })
    ])
    expect((await run('chat list', { state: 'working' }, client)).chats).toEqual([])
  })
})

describe('chat read', () => {
  it('returns messages, tools and waiting prompts, without provider status frames', async () => {
    const client = fakeClient([
      historyPage([
        item({ kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Run tests' }] }),
        item({ kind: 'tool-call', name: 'shell', input: {}, state: 'completed' }),
        item({ kind: 'status', text: 'codex · notification' }),
        item({
          kind: 'approval',
          title: 'Allow git push?',
          detail: null,
          options: [],
          resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null }
        }),
        item({
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: '2 failures.' }]
        })
      ])
    ])
    const result = await run('chat read', { session: HANDLE, limit: '4' }, client)
    expect(client.call).toHaveBeenCalledWith('agentSession.history', {
      sessionId: SESSION,
      direction: 'tail',
      limit: 16
    })
    expect(result.entries).toEqual([
      { kind: 'message', role: 'user', text: 'Run tests' },
      { kind: 'tool', name: 'shell', state: 'completed' },
      { kind: 'approval', text: 'Allow git push?', pending: true },
      { kind: 'message', role: 'assistant', text: '2 failures.' }
    ])
  })

  it('shows the requested number of entries, the newest ones', async () => {
    const client = fakeClient([
      historyPage([
        item({ kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'first' }] }),
        item({ kind: 'status', text: 'frame' }),
        item({ kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'second' }] }),
        item({ kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'third' }] })
      ])
    ])
    const result = await run('chat read', { session: SESSION, limit: '2' }, client)
    expect(result.entries.map((entry: { text: string }) => entry.text)).toEqual(['second', 'third'])
  })

  it('pages backward when status frames leave the requested limit unfilled', async () => {
    const client = fakeClient([
      historyPage([item({ kind: 'status', text: 'frame' })], 3, {
        window: { oldest: { epoch: 'e', sequence: 9 } },
        hasOlder: true
      }),
      historyPage(
        [
          item({ kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'first' }] }),
          item({ kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'second' }] })
        ],
        3,
        { window: { oldest: { epoch: 'e', sequence: 1 } }, hasOlder: false }
      )
    ])
    const result = await run('chat read', { session: SESSION, limit: '2' }, client)
    expect(client.call).toHaveBeenNthCalledWith(2, 'agentSession.history', {
      sessionId: SESSION,
      direction: 'before',
      cursor: { epoch: 'e', sequence: 9 },
      limit: 200
    })
    expect(result.entries.map((entry: { text: string }) => entry.text)).toEqual(['first', 'second'])
  })

  it('replaces the window with a reset page instead of mixing it into older rows', async () => {
    const client = fakeClient([
      historyPage([item({ kind: 'status', text: 'frame' })], 3, {
        window: { oldest: { epoch: 'e', sequence: 9 } },
        hasOlder: true
      }),
      ok({
        ok: false,
        reset: 'journal-truncated',
        page: {
          sessionId: SESSION,
          epoch: 'e2',
          fence: 4,
          direction: 'tail',
          items: [
            item({ kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'fresh' }] })
          ],
          removedItemIds: [],
          submissions: [],
          window: { oldest: { epoch: 'e2', sequence: 1 } },
          hasOlder: false
        }
      })
    ])
    const result = await run('chat read', { session: SESSION, limit: '2' }, client)
    expect(client.call).toHaveBeenNthCalledWith(2, 'agentSession.history', {
      sessionId: SESSION,
      direction: 'before',
      cursor: { epoch: 'e', sequence: 9 },
      limit: 200
    })
    expect(result.entries.map((entry: { text: string }) => entry.text)).toEqual(['fresh'])
  })
})

describe('chat send', () => {
  it('sends a host-valid message fenced to the chat it read, queued while the agent works', async () => {
    const client = fakeClient([
      historyPage([], 7),
      ok({
        ok: true,
        replayed: false,
        fence: 7,
        cursor: { epoch: 'e', sequence: 2 },
        value: {
          clientMessageId: 'm-1',
          queued: { messageId: 'q-1', position: 1, state: 'waiting' }
        }
      })
    ])
    const result = await run('chat send', { session: SESSION, text: 'Run the tests' }, client)
    const params = client.call.mock.calls[1]![1]
    expect(client.call.mock.calls[1]![0]).toBe('agentSession.send')
    // The host validates the same schema, so a malformed envelope or body fails here.
    expect(SendParams.safeParse(params).success).toBe(true)
    expect(params).toMatchObject({
      envelope: { sessionId: SESSION, expectedRuntimeFence: 7 },
      delivery: 'queue-if-active',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Run the tests' }] }
    })
    expect(result).toEqual({
      session: SESSION,
      delivery: 'queued',
      clientMessageId: 'm-1',
      queuePosition: 1
    })
  })

  it('sends without the queue field to a host that has no message queue', async () => {
    const client = fakeClient(
      [
        historyPage([], 2),
        ok({
          ok: true,
          replayed: false,
          fence: 2,
          cursor: { epoch: 'e', sequence: 1 },
          value: { clientMessageId: 'm-2', submission: {} }
        })
      ],
      []
    )
    const result = await run('chat send', { session: SESSION, text: 'hi' }, client)
    expect(client.call.mock.calls[1]![1]).not.toHaveProperty('delivery')
    expect(result.delivery).toBe('submitted')
  })

  it('reports a host refusal as an error instead of a sent message', async () => {
    const client = fakeClient([
      historyPage([], 2),
      ok({
        ok: false,
        refusal: { code: 'agent_session_fence_mismatch', message: 'The chat restarted.' }
      })
    ])
    await expect(run('chat send', { session: SESSION, text: 'hi' }, client)).rejects.toMatchObject({
      code: 'agent_session_fence_mismatch'
    })
  })

  it('refuses empty text before contacting the host', async () => {
    const client = fakeClient([])
    await expect(run('chat send', { session: SESSION, text: '  ' }, client)).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(client.call).not.toHaveBeenCalled()
  })
})
