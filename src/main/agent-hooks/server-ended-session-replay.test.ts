import { afterEach, describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'

// A reconnecting SSH relay re-sends the status it cached for every pane. Once a pane's agent was
// proven to have exited, a replay of that same session must not bring its row back; a new turn or
// another session is newer evidence and must.

const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const CONNECTION = 'conn-a'

const servers: AgentHookServer[] = []

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
})

async function startServer(): Promise<AgentHookServer> {
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production' })
  return server
}

function event(
  agentType: 'claude' | 'codex',
  hookEventName: string,
  options: {
    state?: 'working' | 'done'
    sessionId?: string
    prompt?: string
    replay?: boolean
  } = {}
) {
  return {
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    source: agentType,
    hookEventName,
    ...(options.sessionId ? { providerSession: { key: 'session_id', id: options.sessionId } } : {}),
    ...(options.replay ? { isReplay: true } : {}),
    payload: { state: options.state ?? 'working', prompt: options.prompt ?? 'task', agentType }
  }
}

function liveRow(server: AgentHookServer) {
  return server.getStatusSnapshotForPane(PANE).find((row) => row.providerSessionOnly !== true)
}

/** The agent finished its turn, then its exit was verified at a command end. */
function doneThenVerifiedExit(
  server: AgentHookServer,
  agentType: 'claude' | 'codex',
  sessionId?: string
) {
  server.ingestRemote(event(agentType, 'UserPromptSubmit', { sessionId }), CONNECTION)
  server.ingestRemote(event(agentType, 'Stop', { state: 'done', sessionId }), CONNECTION)
  expect(liveRow(server)?.state).toBe('done')
  server.reconcileEndedProcessForPaneKeys([PANE], {
    preserveResumeIdentity: true,
    armedRowReceivedAt: liveRow(server)!.receivedAt
  })
  expect(liveRow(server)).toBeUndefined()
}

describe('a relay replay after a verified agent exit', () => {
  for (const [agentType, sessionId] of [
    ['claude', 'claude-session'],
    ['codex', undefined]
  ] as const) {
    it(`does not bring back the ended ${agentType} session`, async () => {
      const server = await startServer()
      doneThenVerifiedExit(server, agentType, sessionId)

      server.ingestRemote(
        event(agentType, 'Stop', { state: 'done', sessionId, replay: true }),
        CONNECTION
      )

      expect(liveRow(server)).toBeUndefined()
    })
  }

  it('admits a replay of another session, started while the relay was away', async () => {
    const server = await startServer()
    doneThenVerifiedExit(server, 'claude', 'claude-session')

    server.ingestRemote(
      event('claude', 'Stop', { state: 'done', sessionId: 'next-session', replay: true }),
      CONNECTION
    )

    expect(liveRow(server)?.state).toBe('done')
  })

  it('admits a new turn, after which a replay is ordinary evidence again', async () => {
    const server = await startServer()
    doneThenVerifiedExit(server, 'codex')

    server.ingestRemote(event('codex', 'UserPromptSubmit', { prompt: 'next task' }), CONNECTION)
    server.ingestRemote(event('codex', 'Stop', { state: 'done', replay: true }), CONNECTION)

    expect(liveRow(server)?.state).toBe('done')
  })

  it('admits a live, non-replayed event from the ended session (it may still be alive)', async () => {
    const server = await startServer()
    doneThenVerifiedExit(server, 'codex')

    server.ingestRemote(event('codex', 'PostToolUse'), CONNECTION)

    expect(liveRow(server)?.state).toBe('working')
  })
})
