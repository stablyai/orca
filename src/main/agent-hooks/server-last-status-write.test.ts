import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { buildBody, postHookEvent, recentTs, PANE, RUNNING_SHELL } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Last-status persistence', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-laststatus-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function lastStatusPath(): string {
    return join(userDataPath, 'agent-hooks', 'last-status.json')
  }

  it('writes last-status.json after a hook event', async () => {
    const server = new AgentHookServer()
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      await postHookEvent(
        server,
        buildBody(
          { hook_event_name: 'UserPromptSubmit', prompt: 'persist me' },
          { launchToken: 'launch-bearer-must-not-persist' }
        )
      )
      await postHookEvent(
        server,
        buildBody(
          { hook_event_name: 'Stop', background_tasks: [RUNNING_SHELL] },
          { launchToken: 'launch-bearer-must-not-persist' }
        )
      )
      // Synchronous flush via stop() captures the trailing-debounced write.
      server.flushStatusPersistSync()
      expect(existsSync(lastStatusPath())).toBe(true)
      const file = JSON.parse(readFileSync(lastStatusPath(), 'utf8'))
      expect(file.version).toBe(2)
      expect(file.entries[PANE]).toMatchObject({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        receivedAt: expect.any(Number),
        stateStartedAt: expect.any(Number),
        payload: expect.objectContaining({
          state: 'working',
          workingMode: 'monitoring',
          prompt: 'persist me'
        })
      })
      expect(file.entries[PANE].launchToken).toBeUndefined()
      expect(file.entries[PANE].launchTokenHash).toBe(
        createHash('sha256').update('launch-bearer-must-not-persist').digest('hex')
      )
      expect(file.entries[PANE].claudeRunningNonAgentTask).toBeUndefined()
      expect(readFileSync(lastStatusPath(), 'utf8')).not.toContain('claudeRunningNonAgentTask')
      expect(readFileSync(lastStatusPath(), 'utf8')).not.toContain('launch-bearer-must-not-persist')
    } finally {
      server.stop()
    }
  })

  it('scrubs a legacy persisted launch bearer while retaining its authority commitment', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    const receivedAt = recentTs()
    const launchToken = 'legacy-launch-bearer'
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: {
          [PANE]: {
            paneKey: PANE,
            launchToken,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            connectionId: null,
            receivedAt,
            stateStartedAt: receivedAt,
            payload: {
              state: 'working',
              prompt: 'legacy worker',
              agentType: 'codex'
            }
          }
        }
      }),
      'utf8'
    )

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      const launchTokenHash = createHash('sha256').update(launchToken).digest('hex')
      expect(server.getHydratedAuthorityCommitments()).toEqual([
        expect.objectContaining({ paneKey: PANE, launchTokenHash })
      ])
      expect(server.getStatusSnapshotForPane(PANE)[0]?.launchToken).toBeUndefined()

      const persisted = readFileSync(lastStatusPath(), 'utf8')
      expect(persisted).not.toContain(launchToken)
      expect(JSON.parse(persisted).entries[PANE]).toMatchObject({ launchTokenHash })
    } finally {
      server.stop()
    }

    const restartedServer = new AgentHookServer()
    await restartedServer.start({ env: 'production', userDataPath })
    try {
      expect(restartedServer.getHydratedAuthorityCommitments()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          launchTokenHash: createHash('sha256').update(launchToken).digest('hex')
        })
      ])
      expect(restartedServer.getStatusSnapshotForPane(PANE)[0]?.launchToken).toBeUndefined()
    } finally {
      restartedServer.stop()
    }
  })

  it('persists SSH authority through transient clears until explicit retirement', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    const receivedAt = recentTs()
    const launchToken = 'retained-ssh-launch-bearer'
    const launchTokenHash = createHash('sha256').update(launchToken).digest('hex')
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: {
          [PANE]: {
            paneKey: PANE,
            launchTokenHash,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            connectionId: 'ssh-target',
            receivedAt,
            stateStartedAt: receivedAt,
            payload: {
              state: 'working',
              prompt: 'retained SSH worker',
              agentType: 'codex'
            }
          }
        }
      }),
      'utf8'
    )

    const first = new AgentHookServer()
    await first.start({ env: 'production', userDataPath })
    first.clearStatusEntriesForConnection('ssh-target')
    first.flushStatusPersistSync()
    first.stop()

    const afterClear = JSON.parse(readFileSync(lastStatusPath(), 'utf8'))
    expect(afterClear.entries).toEqual({})
    expect(afterClear.authorityCommitments[PANE]).toMatchObject({
      paneKey: PANE,
      launchTokenHash,
      connectionId: 'ssh-target'
    })

    const restored = new AgentHookServer()
    await restored.start({ env: 'production', userDataPath })
    expect(
      restored.attestCompatibilityAuthority({
        paneKey: PANE,
        launchTokenHash,
        connectionId: 'ssh-target',
        terminalProvenance: 'restored'
      })
    ).toEqual({ paneKey: PANE, source: 'hydrated_commitment' })
    restored.retirePaneAuthority(PANE)
    restored.flushStatusPersistSync()
    restored.stop()

    const retired = new AgentHookServer()
    await retired.start({ env: 'production', userDataPath })
    try {
      expect(
        retired.attestCompatibilityAuthority({
          paneKey: PANE,
          launchTokenHash,
          connectionId: 'ssh-target',
          terminalProvenance: 'restored'
        })
      ).toBeNull()
    } finally {
      retired.stop()
    }
  })

  it('persists and hydrates Pi session identity without creating status telemetry', async () => {
    const firstServer = new AgentHookServer()
    const firstRendererListener = vi.fn()
    const statusChangeListener = vi.fn()
    firstServer.setListener(firstRendererListener)
    firstServer.subscribeStatusChanges(statusChangeListener)
    await firstServer.start({ env: 'production', userDataPath })
    try {
      const response = await postHookEvent(
        firstServer,
        buildBody({
          hook_event_name: 'session_start',
          session_id: 'pi-session-1',
          session_file: '/tmp/pi-session-1.jsonl'
        }),
        '/hook/pi'
      )
      expect(response.status).toBe(204)
      expect(firstRendererListener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          providerSessionOnly: true,
          providerSession: {
            key: 'session_id',
            id: 'pi-session-1',
            transcriptPath: '/tmp/pi-session-1.jsonl'
          }
        })
      )
      expect(statusChangeListener).toHaveBeenCalledWith([])
      expect(trackMock).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())

      firstServer.flushStatusPersistSync()
      const file = JSON.parse(readFileSync(lastStatusPath(), 'utf8'))
      expect(file.entries[PANE]).toMatchObject({
        providerSessionOnly: true,
        providerSession: {
          key: 'session_id',
          id: 'pi-session-1',
          transcriptPath: '/tmp/pi-session-1.jsonl'
        }
      })
    } finally {
      firstServer.stop()
    }

    const hydratedServer = new AgentHookServer()
    await hydratedServer.start({ env: 'production', userDataPath })
    try {
      const hydratedListener = vi.fn()
      hydratedServer.setListener(hydratedListener)
      expect(hydratedListener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          providerSessionOnly: true,
          providerSession: expect.objectContaining({ transcriptPath: '/tmp/pi-session-1.jsonl' }),
          isReplay: true
        })
      )
      expect(hydratedServer.getStatusChangeSnapshot()).toEqual([])
    } finally {
      hydratedServer.stop()
    }
  })

  it('does not write prompt interaction keys to last-status.json', async () => {
    const server = new AgentHookServer()
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      await postHookEvent(
        server,
        buildBody({
          hook_event_name: 'MessagePart',
          role: 'user',
          text: 'persist status only',
          messageID: 'opencode-local-message-id'
        }),
        '/hook/opencode'
      )
      server.flushStatusPersistSync()
      const file = JSON.parse(readFileSync(lastStatusPath(), 'utf8'))
      expect(file.entries[PANE].payload.prompt).toBe('persist status only')
      expect(file.entries[PANE].promptInteractionKey).toBeUndefined()
    } finally {
      server.stop()
    }
  })
})
