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
      paneKey?: string
    ) => Promise<Response>
  }> {
    const server = new AgentHookServer()
    servers.push(server)
    await server.start({ env: 'production' })
    const env = server.buildPtyEnv()
    return {
      server,
      post: (payload, launchToken, paneKey = PANE) =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/opencode`, {
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

  it('replaces a destination token fence when pane authority transfers', async () => {
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
})
