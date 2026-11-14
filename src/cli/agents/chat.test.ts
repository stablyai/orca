import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime/client'
import { CHAT_HANDLERS } from './chat'
import { AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY } from '../../shared/agent-session/agent-session-runtime-capabilities'

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

describe('chat send and chat close CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function hostClient(answers: Record<string, unknown>, capabilities: string[] = []) {
    const client = new RuntimeClient('/tmp/orca-chat-test', 60_000, null, null)
    vi.spyOn(client, 'getCliStatus').mockResolvedValue({
      id: 'req-status',
      ok: true,
      result: { runtime: { reachable: true, capabilities } },
      _meta: { runtimeId: 'runtime-1' }
    } as never)
    const call = vi.fn(async (method: string, _params?: unknown) => ({
      id: `req-${method}`,
      ok: true,
      result: answers[method],
      _meta: { runtimeId: 'runtime-1' }
    }))
    vi.spyOn(client, 'call').mockImplementation(call as never)
    return { client, call }
  }

  const sent = {
    ok: true,
    replayed: false,
    fence: 4,
    value: { clientMessageId: 'm-1', submission: {} }
  }

  it('sends the text to the chat fenced to its current runtime, queued while a turn runs', async () => {
    const { client, call } = hostClient(
      { 'agentSession.history': { ok: true, page: { fence: 4 } }, 'agentSession.send': sent },
      [AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY]
    )
    await CHAT_HANDLERS['chat send']({
      flags: new Map([
        ['session', 'claude_1'],
        ['text', 'Continue']
      ]),
      client,
      cwd: '/tmp/worktree',
      json: true
    })
    const [, send] = call.mock.calls.find(([method]) => method === 'agentSession.send')!
    expect(send).toMatchObject({
      envelope: { sessionId: 'claude_1', expectedRuntimeFence: 4 },
      delivery: 'queue-if-active',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Continue' }] }
    })
  })

  it('refuses an empty message before it reaches the host', async () => {
    const { client, call } = hostClient({})
    await expect(
      CHAT_HANDLERS['chat send']({
        flags: new Map([
          ['session', 'claude_1'],
          ['text', '  ']
        ]),
        client,
        cwd: '/tmp/worktree',
        json: true
      })
    ).rejects.toThrow('The message must not be empty.')
    expect(call).not.toHaveBeenCalled()
  })

  it('reports a refused send as an error', async () => {
    const { client } = hostClient({
      'agentSession.history': { ok: true, page: { fence: 4 } },
      'agentSession.send': {
        ok: false,
        refusal: { code: 'agent_session_fenced', message: 'stale' }
      }
    })
    await expect(
      CHAT_HANDLERS['chat send']({
        flags: new Map([
          ['session', 'claude_1'],
          ['text', 'Continue']
        ]),
        client,
        cwd: '/tmp/worktree',
        json: true
      })
    ).rejects.toThrow('stale')
  })

  it('closes the chat by its session id', async () => {
    const { client, call } = hostClient({ 'agentSession.close': { ok: true } })
    await CHAT_HANDLERS['chat close']({
      flags: new Map([['session', 'claude_1']]),
      client,
      cwd: '/tmp/worktree',
      json: true
    })
    expect(call).toHaveBeenCalledWith('agentSession.close', { sessionId: 'claude_1' })
  })
})
