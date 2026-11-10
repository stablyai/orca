import { afterEach, describe, expect, it, vi } from 'vitest'
import { SendParams } from '../../shared/rpc-contract/structured-agent-session-params'
import { AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY } from '../../shared/agent-session/agent-session-runtime-capabilities'
import { RuntimeClient } from '../runtime-client'
import { CHAT_HANDLERS } from './chat'

const SESSION = 'codex_8eb631ab_59c5_41e4_8672_01cfe0a6fd5f'

function ok(result: unknown) {
  return { id: 'req', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
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
      window: {
        oldest: null,
        newest: { epoch: 'e', sequence: 9 },
        nextCursor: { epoch: 'e', sequence: 9 }
      },
      ...pageOverrides
    }
  })
}

function item(body: unknown) {
  return { itemId: 'i', revision: 1, sequence: 1, observedAt: 1, body }
}

function fakeClient(
  responses: unknown[],
  capabilities: string[] = [AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY]
): RuntimeClient & { call: ReturnType<typeof vi.fn> } {
  const client = new RuntimeClient('/tmp/orca-chat-test', 60_000, null, null)
  const call = vi.fn()
  for (const response of responses) {
    call.mockResolvedValueOnce(response)
  }
  vi.spyOn(client, 'call').mockImplementation(call)
  vi.spyOn(client, 'getCliStatus').mockResolvedValue({
    id: 'status',
    ok: true,
    result: {
      app: { running: true, pid: 123 },
      runtime: { state: 'ready', reachable: true, runtimeId: 'runtime-1', capabilities },
      graph: { state: 'ready' }
    },
    _meta: { runtimeId: 'runtime-1' }
  })
  return Object.assign(client, { call })
}

async function run(
  command: string,
  flags: Record<string, string | boolean>,
  client: RuntimeClient
) {
  const logs: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(line))
  try {
    await CHAT_HANDLERS[command]!({
      flags: new Map(Object.entries(flags)),
      client,
      cwd: '/tmp',
      json: true
    })
  } finally {
    spy.mockRestore()
  }
  return JSON.parse(logs.join('\n')).result
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
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

  it('with --wait, waits for its queued message to run and returns that turn', async () => {
    vi.useFakeTimers()
    const client = fakeClient([
      historyPage([], 7, { working: true }),
      ok({
        ok: true,
        replayed: false,
        fence: 7,
        cursor: { epoch: 'e', sequence: 2 },
        value: {
          clientMessageId: 'm-1',
          queued: { messageId: 'q-1', position: 1, state: 'waiting' }
        }
      }),
      // The earlier turn ended, but the queued message has not been handed to the agent yet.
      historyPage([], 7, {
        working: false,
        queuedMessages: [{ messageId: 'q-1' }],
        nextQueuedMessageId: 'q-1'
      }),
      historyPage([], 7, { working: true, queuedMessages: [] }),
      historyPage([], 7, { working: false, queuedMessages: [], actionablePromptIds: [] }),
      historyPage([
        item({ kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Earlier' }] }),
        item({ kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Old reply' }] }),
        item({ kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Run the tests' }] }),
        item({ kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'All pass' }] })
      ])
    ])
    const pending = run(
      'chat send',
      { session: SESSION, text: 'Run the tests', wait: true },
      client
    )
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await pending
    expect(client.call).toHaveBeenCalledTimes(6)
    expect(result).toMatchObject({
      delivery: 'queued',
      settled: 'done',
      entries: [{ kind: 'message', role: 'assistant', text: 'All pass' }]
    })
  })
})

function chatClient(isRemote: boolean): { client: RuntimeClient; call: ReturnType<typeof vi.fn> } {
  const client = new RuntimeClient('/tmp/orca-chat-test', 60_000, null, null)
  vi.spyOn(client, 'isRemote', 'get').mockReturnValue(isRemote)
  const call = vi.fn().mockResolvedValue({
    id: 'req-rename',
    ok: true,
    result: { name: 'Release notes', applied: true },
    _meta: { runtimeId: 'runtime-1' }
  })
  vi.spyOn(client, 'call').mockImplementation(call)
  return { client, call }
}

function rename(client: RuntimeClient, session?: string): Promise<void> {
  return CHAT_HANDLERS['chat rename']({
    flags: new Map([
      ['name', 'Release notes'],
      ...(session === undefined ? [] : [['session', session] as const])
    ]),
    client,
    cwd: '/tmp/worktree',
    json: true
  })
}

describe('chat rename CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('never sends this machine’s chat id to a paired host', async () => {
    vi.stubEnv('ORCA_AGENT_SESSION_ID', 'chat-7')
    const { client, call } = chatClient(true)

    await expect(rename(client)).rejects.toThrow('Missing required --session: on a paired host')
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses an empty --session instead of renaming the chat it runs in', async () => {
    vi.stubEnv('ORCA_AGENT_SESSION_ID', 'chat-7')
    const { client, call } = chatClient(false)

    await expect(rename(client, '')).rejects.toThrow('Missing value for --session')
    expect(call).not.toHaveBeenCalled()
  })
})
