import { afterEach, describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'

const PANE = makePaneKey('tab-opencode', '11111111-1111-4111-8111-111111111111')
const TARGET_PANE = makePaneKey('tab-opencode', '22222222-2222-4222-8222-222222222222')

describe('AgentHookServer OpenCode lifecycle', () => {
  const servers: AgentHookServer[] = []

  afterEach(() => {
    for (const server of servers) {
      server.stop()
    }
    servers.length = 0
  })

  async function setup(): Promise<{
    server: AgentHookServer
    post: (
      payload: Record<string, unknown>,
      launchToken: string,
      paneKey?: string,
      source?: 'opencode' | 'mimo-code'
    ) => Promise<Response>
  }> {
    const server = new AgentHookServer()
    servers.push(server)
    await server.start({ env: 'production' })
    const env = server.buildPtyEnv()
    return {
      server,
      post: (payload, launchToken, paneKey = PANE, source = 'opencode') =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/${source}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify({
            paneKey,
            launchToken,
            tabId: 'tab-opencode',
            worktreeId: 'wt-opencode',
            env: 'production',
            payload
          })
        })
    }
  }

  it('accepts Busy after a retired pane receives a root SessionStart', async () => {
    const { server, post } = await setup()
    await post({ hook_event_name: 'SessionBusy', sessionID: 'old' }, 'old-token')
    server.retirePaneAuthority(PANE)

    await post({ hook_event_name: 'SessionStart', sessionID: 'fresh' }, 'fresh-token')
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: PANE,
        state: 'done',
        sessionBoundary: true,
        providerSession: { key: 'session_id', id: 'fresh' }
      })
    ])

    await post({ hook_event_name: 'SessionBusy', sessionID: 'fresh' }, 'fresh-token')

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: PANE, state: 'working', agentType: 'opencode' })
    ])
  })

  it('accepts a resumed fresh user MessagePart but not arbitrary Busy', async () => {
    const { server, post } = await setup()
    await post({ hook_event_name: 'SessionBusy', sessionID: 'old' }, 'old-token')
    server.retirePaneAuthority(PANE)

    await post({ hook_event_name: 'SessionBusy', sessionID: 'resumed' }, 'resume-token')
    expect(server.getStatusSnapshot()).toEqual([])

    await post(
      {
        hook_event_name: 'MessagePart',
        role: 'user',
        text: 'continue the task',
        messageID: 'message-resumed',
        sessionID: 'resumed'
      },
      'resume-token'
    )

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ state: 'working', prompt: 'continue the task' })
    ])
  })

  it('maps question.asked attention to Waiting after restart', async () => {
    const { server, post } = await setup()
    await post({ hook_event_name: 'SessionBusy', sessionID: 'old' }, 'old-token')
    server.retirePaneAuthority(PANE)
    await post({ hook_event_name: 'SessionStart', sessionID: 'fresh' }, 'fresh-token')

    await post(
      { hook_event_name: 'AskUserQuestion', id: 'question-1', sessionID: 'fresh' },
      'fresh-token'
    )

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ state: 'waiting', agentType: 'opencode' })
    ])
  })

  it('suppresses stale old-token Busy after a fresh restart', async () => {
    const { server, post } = await setup()
    await post({ hook_event_name: 'SessionBusy', sessionID: 'old' }, 'old-token')
    server.retirePaneAuthority(PANE)
    await post({ hook_event_name: 'SessionStart', sessionID: 'fresh' }, 'fresh-token')
    await post({ hook_event_name: 'SessionBusy', sessionID: 'fresh' }, 'fresh-token')

    await post(
      { hook_event_name: 'SessionBusy', sessionID: 'old', prompt: 'stale prompt' },
      'old-token'
    )

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ state: 'working', prompt: '' })
    ])
  })

  it('clears the destination token fence when pane authority transfers', async () => {
    const { server, post } = await setup()
    await post(
      { hook_event_name: 'SessionBusy', sessionID: 'target-old' },
      'target-old-token',
      TARGET_PANE
    )
    server.retirePaneAuthority(TARGET_PANE)
    await post(
      { hook_event_name: 'SessionStart', sessionID: 'target-fresh' },
      'target-fresh-token',
      TARGET_PANE
    )
    await post({ hook_event_name: 'SessionBusy', sessionID: 'source' }, 'source-token')

    await post(
      { hook_event_name: 'SessionBusy', sessionID: 'source-before-transfer' },
      'source-token',
      TARGET_PANE
    )
    expect(
      server.getStatusSnapshot().find((entry) => entry.paneKey === TARGET_PANE)?.providerSession
    ).toEqual({ key: 'session_id', id: 'target-fresh' })

    server.transferPaneAuthority(PANE, TARGET_PANE, 'pty-opencode')
    await post(
      { hook_event_name: 'SessionBusy', sessionID: 'source-after-transfer' },
      'source-token',
      TARGET_PANE
    )

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: TARGET_PANE,
        providerSession: { key: 'session_id', id: 'source-after-transfer' }
      })
    ])
  })

  it('re-fences on a new SessionStart while the pane stays authorized', async () => {
    const { server, post } = await setup()
    await post({ hook_event_name: 'SessionBusy', sessionID: 'old' }, 'old-token')
    server.retirePaneAuthority(PANE)
    await post({ hook_event_name: 'SessionStart', sessionID: 'restart' }, 'restart-token')
    await post({ hook_event_name: 'SessionBusy', sessionID: 'restart' }, 'restart-token')
    await post({ hook_event_name: 'SessionBusy', sessionID: 'old' }, 'old-token')
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ providerSession: { key: 'session_id', id: 'restart' } })
    ])

    // A new process may start before foreground retirement; its SessionStart must replace the stale fence.
    await post({ hook_event_name: 'SessionStart', sessionID: 'fresh' }, 'fresh-token')
    await post({ hook_event_name: 'SessionBusy', sessionID: 'fresh' }, 'fresh-token')

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ providerSession: { key: 'session_id', id: 'fresh' } })
    ])
  })

  it('keeps the fence when a live pane sees a tokenless SessionStart', async () => {
    const { server, post } = await setup()
    await post({ hook_event_name: 'SessionBusy', sessionID: 'old' }, 'old-token')
    server.retirePaneAuthority(PANE)
    await post({ hook_event_name: 'SessionStart', sessionID: 'restart' }, 'restart-token')
    await post({ hook_event_name: 'SessionBusy', sessionID: 'restart' }, 'restart-token')

    // A tokenless boundary cannot prove process identity or reopen the stale-token fence.
    await post({ hook_event_name: 'SessionStart', sessionID: 'tokenless' }, '')
    await post({ hook_event_name: 'SessionBusy', sessionID: 'old' }, 'old-token')

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ providerSession: { key: 'session_id', id: 'restart' } })
    ])
  })

  it('does not let a stale explicit prompt re-fence a live pane', async () => {
    const { server, post } = await setup()
    await post({ hook_event_name: 'SessionBusy', sessionID: 'old' }, 'old-token')
    server.retirePaneAuthority(PANE)
    await post({ hook_event_name: 'SessionStart', sessionID: 'restart' }, 'restart-token')
    await post({ hook_event_name: 'SessionBusy', sessionID: 'restart' }, 'restart-token')

    // Mid-session prompts cannot prove a new process owns the pane.
    await post(
      {
        hook_event_name: 'MessagePart',
        role: 'user',
        text: 'stale prompt',
        messageID: 'message-stale',
        sessionID: 'old'
      },
      'old-token'
    )
    await post({ hook_event_name: 'SessionBusy', sessionID: 'old' }, 'old-token')

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ providerSession: { key: 'session_id', id: 'restart' }, prompt: '' })
    ])
  })

  it('restarts a retired mimo-code pane on an explicit user prompt', async () => {
    const { server, post } = await setup()
    await post({ hook_event_name: 'SessionBusy', sessionID: 'old' }, 'old-token', PANE, 'mimo-code')
    server.retirePaneAuthority(PANE)

    // mimo-code has no SessionStart; its explicit prompt is the restart boundary.
    await post(
      {
        hook_event_name: 'MessagePart',
        role: 'user',
        text: 'continue the task',
        messageID: 'message-resumed',
        sessionID: 'resumed'
      },
      'resume-token',
      PANE,
      'mimo-code'
    )

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ state: 'working', prompt: 'continue the task' })
    ])
  })
})
