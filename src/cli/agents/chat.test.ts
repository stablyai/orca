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

function rename(client: RuntimeClient): Promise<void> {
  return CHAT_HANDLERS['chat rename']({
    flags: new Map([['name', 'Release notes']]),
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

  it('saves on and off on the chat, reads without a choice, and refuses an unknown action', async () => {
    const { client, call } = chatClient(false)
    call.mockResolvedValue({
      id: 'req-rc',
      ok: true,
      result: { status: 'ok', choice: 'on', live: true },
      _meta: { runtimeId: 'runtime-1' }
    })
    const run = (action?: string) =>
      CHAT_HANDLERS['chat remote-control']({
        flags: new Map([['session', 'chat-7'], ...(action ? [['action', action] as const] : [])]),
        client,
        cwd: '/tmp/worktree',
        json: true
      })

    await run('on')
    await run('off')
    await run()
    await expect(run('maybe')).rejects.toThrow('Unknown action "maybe"')

    expect(call.mock.calls).toEqual([
      ['agentSession.providerRemoteControl', { sessionId: 'chat-7', choice: 'on' }],
      ['agentSession.providerRemoteControl', { sessionId: 'chat-7', choice: 'off' }],
      ['agentSession.providerRemoteControl', { sessionId: 'chat-7' }]
    ])
  })

  it('says an organization default turned a link on, and claims nothing pending once off has applied', async () => {
    const { client, call } = chatClient(false)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const status = (result: unknown) => {
      call.mockResolvedValueOnce({
        id: 'req-rc',
        ok: true,
        result,
        _meta: { runtimeId: 'runtime-1' }
      })
      return CHAT_HANDLERS['chat remote-control']({
        flags: new Map([['session', 'chat-7']]),
        client,
        cwd: '/tmp/worktree',
        json: false
      })
    }

    await status({ status: 'ok', choice: 'off', live: false })
    await status({
      status: 'ok',
      live: false,
      link: { state: 'connected', enabledByDefault: true }
    })

    expect(log.mock.calls.map(([text]) => text)).toEqual([
      'Remote Control: off\nSaved choice: off',
      'Remote Control: connected\nTurned on by an organization or rollout default.\nSaved choice: follows the Remote Control setting'
    ])
  })

  it('never sends this machine’s chat id to a paired host', async () => {
    vi.stubEnv('ORCA_AGENT_SESSION_ID', 'chat-7')
    const { client, call } = chatClient(true)

    await expect(rename(client)).rejects.toThrow('Missing required --session: on a paired host')
    expect(call).not.toHaveBeenCalled()
  })
})
