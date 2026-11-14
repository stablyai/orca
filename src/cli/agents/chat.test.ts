import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime/client'
import { CHAT_HANDLERS } from './chat'

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

  it('requires an explicit target session for remote usage reads', async () => {
    vi.stubEnv('ORCA_AGENT_SESSION_ID', 'local-chat')
    const { client } = chatClient(true)
    await expect(
      CHAT_HANDLERS['chat usage']({
        flags: new Map(),
        client,
        cwd: '/tmp/worktree',
        json: true
      })
    ).rejects.toThrow('Missing required --session')
  })
})
