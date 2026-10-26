import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { buildBody, postHookEvent, PANE } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

const RESUMED = { key: 'session_id' as const, id: 'resumed-session' }

// Codex may stay silent until the resumed pane's first turn; seed identity at launch for every reader.
describe('a resume launch seeds the pane identity', () => {
  const servers: AgentHookServer[] = []
  let userDataPath: string

  beforeEach(() => {
    _internals.resetCachesForTests()
    getCohortAtEmitMock.mockReturnValue({})
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-launch-resume-identity-'))
  })

  afterEach(() => {
    for (const server of servers) {
      server.stop()
    }
    servers.length = 0
    rmSync(userDataPath, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  async function startServer(): Promise<AgentHookServer> {
    const server = new AgentHookServer()
    servers.push(server)
    await server.start({ env: 'production', userDataPath })
    return server
  }

  it('publishes an identity-only row before the agent reports', async () => {
    const server = await startServer()
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      worktreeId: 'wt-1',
      agentType: 'codex',
      providerSession: RESUMED,
      launchedAt: Date.now()
    })
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([
      expect.objectContaining({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        agentType: 'codex',
        providerSession: RESUMED,
        providerSessionOnly: true
      })
    ])
  })

  it('yields to a newer agent report', async () => {
    const server = await startServer()
    const launchedAt = Date.now() - 1_000
    const response = await postHookEvent(
      server,
      buildBody({ hook_event_name: 'SessionStart', session_id: 'agent-reported' }),
      '/hook/codex'
    )
    expect(response.status).toBe(204)
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      agentType: 'codex',
      providerSession: RESUMED,
      launchedAt
    })
    expect(server.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe('agent-reported')
  })

  it("replaces a row left by the pane's previous process", async () => {
    const server = await startServer()
    const response = await postHookEvent(
      server,
      buildBody({ hook_event_name: 'Stop', session_id: 'previous-run' }),
      '/hook/codex'
    )
    expect(response.status).toBe(204)
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      agentType: 'codex',
      providerSession: RESUMED,
      launchedAt: Date.now() + 1_000
    })
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      providerSession: RESUMED,
      providerSessionOnly: true
    })

    await postHookEvent(
      server,
      buildBody({ hook_event_name: 'UserPromptSubmit', session_id: RESUMED.id, prompt: 'go on' }),
      '/hook/codex'
    )
    const [row] = server.getStatusSnapshotForPane(PANE)
    expect(row?.providerSessionOnly).toBeUndefined()
    expect(row).toMatchObject({ state: 'working', providerSession: RESUMED })
  })

  it('keeps the seeded identity when terminal evidence starts the first turn', async () => {
    const server = await startServer()
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      agentType: 'opencode2',
      providerSession: RESUMED,
      launchedAt: Date.now()
    })
    server.ingestTerminalStatus({
      paneKey: PANE,
      origin: 'process',
      payload: { state: 'working', prompt: '', agentType: 'opencode2' }
    })
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'working',
      providerSession: RESUMED
    })
  })

  it('keeps the seeded identity across a host restart', async () => {
    const server = await startServer()
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      worktreeId: 'wt-1',
      agentType: 'codex',
      providerSession: RESUMED,
      launchedAt: Date.now()
    })
    server.stop()
    servers.length = 0
    const restarted = await startServer()
    expect(restarted.getStatusSnapshotForPane(PANE)).toEqual([
      expect.objectContaining({
        agentType: 'codex',
        providerSession: RESUMED,
        providerSessionOnly: true
      })
    ])
  })

  it('ignores a pane key that is not a stable tab:leaf key', async () => {
    const server = await startServer()
    server.recordLaunchResumeIdentity({
      paneKey: 'not-a-pane',
      agentType: 'codex',
      providerSession: RESUMED,
      launchedAt: Date.now()
    })
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('binds a trusted Jcode resume before its first hook without local files', async () => {
    const server = await startServer()
    vi.stubEnv('JCODE_HOME', userDataPath)
    try {
      server.recordLaunchResumeIdentity({
        paneKey: PANE,
        agentType: 'jcode',
        providerSession: RESUMED,
        launchedAt: Date.now()
      })
      expect(server._getStateForTests().jcodeSessions.roots.get(PANE)).toBe(RESUMED.id)
      await postHookEvent(
        server,
        buildBody({
          event: 'turn_start',
          session_id: RESUMED.id,
          prompt: 'resume prompt',
          model: 'claude-opus-5-5'
        }),
        '/hook/jcode'
      )
      await postHookEvent(
        server,
        buildBody({ event: 'turn_start', session_id: 'unknown-worker', prompt: 'must not leak' }),
        '/hook/jcode'
      )
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        providerSession: RESUMED,
        state: 'working',
        prompt: 'resume prompt',
        model: 'claude-opus-5-5'
      })
      expect(server.getStatusSnapshot()[0].subagents).toBeUndefined()
      server.recordLaunchResumeIdentity({
        paneKey: PANE,
        agentType: 'jcode',
        providerSession: { key: 'session_id', id: 'obsolete-root' },
        launchedAt: Date.now() - 1000
      })
      expect(server._getStateForTests().jcodeSessions.roots.get(PANE)).toBe(RESUMED.id)
      expect(server.getStatusSnapshot()[0].providerSession).toEqual(RESUMED)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
