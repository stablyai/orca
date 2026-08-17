import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey('tab-1', LEAF)

beforeEach(() => {
  _internals.resetCachesForTests()
})

async function withServer(run: (server: AgentHookServer) => Promise<void>): Promise<void> {
  const server = new AgentHookServer()
  await server.start({ env: 'production' })
  try {
    await run(server)
  } finally {
    server.stop()
  }
}

function postHook(
  server: AgentHookServer,
  source: string,
  payload: Record<string, unknown>
): Promise<Response> {
  const env = server.buildPtyEnv()
  return fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/${source}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      env: 'production',
      launchToken: 'retired-launch-token',
      payload
    })
  })
}

describe('retired reusable pane accepts each provider new-turn boundary', () => {
  it('completes a Cursor turn after launch authority retires (#12686)', async () => {
    await withServer(async (server) => {
      await postHook(server, 'cursor', {
        hook_event_name: 'beforeSubmitPrompt',
        prompt: 'first Cursor turn'
      })
      server.retirePaneAuthority(PANE)

      // The reused shell pane runs a whole new Cursor turn. Before the fix every
      // event here was suppressed, so the pane never reached `done` — and the
      // hook-driven synthetic spinner that main starts on `working` was never
      // stopped, leaving the pane visibly stuck on Working.
      await postHook(server, 'cursor', {
        hook_event_name: 'beforeSubmitPrompt',
        prompt: 'restored Cursor turn'
      })
      await postHook(server, 'cursor', { hook_event_name: 'stop', status: 'completed' })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          agentType: 'cursor',
          state: 'done',
          prompt: 'restored Cursor turn'
        })
      ])
    })
  })

  // Why: each provider names its own turn boundary. Before the fix only Claude's two
  // names could reopen a retired pane, so every other provider stayed suppressed.
  it.each([
    ['cursor', { hook_event_name: 'beforeSubmitPrompt' }],
    ['cursor', { hook_event_name: 'sessionStart' }],
    ['gemini', { hook_event_name: 'BeforeAgent' }],
    ['antigravity', { hook_event_name: 'PreInvocation' }],
    ['pi', { hook_event_name: 'before_agent_start' }],
    ['claude', { hook_event_name: 'UserPromptSubmit' }],
    ['claude', { hook_event_name: 'SessionStart', source: 'resume' }]
  ])('reopens a retired pane for %s %o', async (source, payload) => {
    await withServer(async (server) => {
      await postHook(server, source, payload)
      server.retirePaneAuthority(PANE)
      expect(server.getStatusSnapshot()).toEqual([])

      await postHook(server, source, payload)

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, agentType: source })
      ])
    })
  })

  it('still reopens a retired pane for a relay frame that carries no source', () => {
    // Why: an older remote client omits `source`; its Claude panes must keep reopening.
    const server = new AgentHookServer()
    server.retirePaneAuthority(PANE)
    server.ingestRemote(
      {
        paneKey: PANE,
        hookEventName: 'UserPromptSubmit',
        payload: { state: 'working', prompt: 'legacy relay restart', agentType: 'claude' }
      },
      'conn-1'
    )

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: PANE, state: 'working', prompt: 'legacy relay restart' })
    ])
  })

  it('keeps a retired pane suppressed for a mid-turn Cursor event', async () => {
    await withServer(async (server) => {
      await postHook(server, 'cursor', {
        hook_event_name: 'beforeSubmitPrompt',
        prompt: 'first Cursor turn'
      })
      server.retirePaneAuthority(PANE)

      // Why: only a live turn boundary may reopen a retired pane — a late tool
      // event from the previous turn must not resurrect it.
      await postHook(server, 'cursor', { hook_event_name: 'postToolUse' })
      await postHook(server, 'cursor', { hook_event_name: 'stop', status: 'completed' })

      expect(server.getStatusSnapshot()).toEqual([])
    })
  })

  it('rejects a replayed Cursor turn boundary in a retired pane', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE,
        source: 'cursor',
        hookEventName: 'beforeSubmitPrompt',
        launchToken: 'retired-launch-token',
        payload: { state: 'working', prompt: 'first Cursor turn', agentType: 'cursor' }
      },
      'conn-1'
    )
    server.retirePaneAuthority(PANE)

    server.ingestRemote(
      {
        paneKey: PANE,
        source: 'cursor',
        hookEventName: 'beforeSubmitPrompt',
        launchToken: 'retired-launch-token',
        isReplay: true,
        payload: { state: 'working', prompt: 'stale Cursor replay', agentType: 'cursor' }
      },
      'conn-1'
    )
    expect(server.getStatusSnapshot()).toEqual([])

    server.ingestRemote(
      {
        paneKey: PANE,
        source: 'cursor',
        hookEventName: 'beforeSubmitPrompt',
        launchToken: 'retired-launch-token',
        payload: { state: 'working', prompt: 'live Cursor restart', agentType: 'cursor' }
      },
      'conn-1'
    )

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: PANE,
        state: 'working',
        prompt: 'live Cursor restart',
        connectionId: 'conn-1'
      })
    ])
  })
})
