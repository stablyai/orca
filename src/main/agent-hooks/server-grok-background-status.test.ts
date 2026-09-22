import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => vi.restoreAllMocks())

async function postGrokHook(
  server: AgentHookServer,
  payload: Record<string, unknown>
): Promise<void> {
  const env = server.buildPtyEnv()
  const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/grok`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify(buildBody(payload))
  })
  expect(response.status).toBe(204)
}

describe('Grok background status ownership', () => {
  it('keeps the host-owned row working while finite background work remains', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await postGrokHook(server, {
        hookEventName: 'user_prompt_submit',
        sessionId: 'session-1',
        promptId: 'prompt-1',
        prompt: 'run a background task'
      })
      await postGrokHook(server, {
        hookEventName: 'stop',
        sessionId: 'session-1',
        promptId: 'prompt-1',
        reason: 'end_turn',
        stopHookActive: false,
        backgroundTasks: [{ id: 'task-1', type: 'shell', status: 'running' }]
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'working',
          workingMode: 'monitoring',
          agentType: 'grok'
        })
      ])

      await postGrokHook(server, {
        hookEventName: 'user_prompt_submit',
        sessionId: 'session-1',
        promptId: 'task-completed-task-1',
        prompt: 'the background task completed'
      })
      await postGrokHook(server, {
        hookEventName: 'stop',
        sessionId: 'session-1',
        promptId: 'task-completed-task-1',
        reason: 'end_turn',
        stopHookActive: false,
        backgroundTasks: []
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'done', agentType: 'grok' })
      ])
    } finally {
      server.stop()
    }
  })

  it('rejects a delayed remote cancellation from the turn replaced by a newer prompt', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        source: 'grok',
        hookEventName: 'UserPromptSubmit',
        providerPromptId: 'prompt-new',
        providerSession: { key: 'session_id', id: 'session-1' },
        payload: { state: 'working', prompt: 'new turn', agentType: 'grok' }
      },
      'conn-1'
    )
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        source: 'grok',
        hookEventName: 'StopCancelled',
        providerPromptId: 'prompt-old',
        providerSession: { key: 'session_id', id: 'session-1' },
        payload: {
          state: 'done',
          prompt: 'old turn',
          agentType: 'grok',
          interrupted: true
        }
      },
      'conn-1'
    )

    expect(server._getStateForTests().lastStatusByPaneKey.get(PANE)).toMatchObject({
      providerPromptId: 'prompt-new',
      payload: { state: 'working', prompt: 'new turn' }
    })
  })

  it('retains an id-less Grok turn fence across status hydration', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-grok-status-'))
    const firstServer = new AgentHookServer()
    const restoredServer = new AgentHookServer()
    try {
      await firstServer.start({ env: 'production', userDataPath })
      firstServer.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          source: 'grok',
          hookEventName: 'UserPromptSubmit',
          grokPromptBoundary: true,
          providerSession: { key: 'session_id', id: 'session-1' },
          payload: { state: 'working', prompt: 'new turn', agentType: 'grok' }
        },
        'conn-1'
      )
      firstServer.flushStatusPersistSync()
      firstServer.stop()

      await restoredServer.start({ env: 'production', userDataPath })
      restoredServer.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          source: 'grok',
          hookEventName: 'StopCancelled',
          providerPromptId: 'prompt-old',
          providerSession: { key: 'session_id', id: 'session-1' },
          payload: {
            state: 'done',
            prompt: 'old turn',
            agentType: 'grok',
            interrupted: true
          }
        },
        'conn-1'
      )

      expect(restoredServer._getStateForTests().lastStatusByPaneKey.get(PANE)).toMatchObject({
        grokPromptBoundary: true,
        payload: { state: 'working', prompt: 'new turn' }
      })

      restoredServer.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          source: 'grok',
          hookEventName: 'Stop',
          grokPromptBoundary: true,
          providerSession: { key: 'session_id', id: 'session-1' },
          payload: { state: 'done', prompt: 'new turn', agentType: 'grok' }
        },
        'conn-1'
      )
      expect(restoredServer.getStatusSnapshot()).toEqual([
        expect.objectContaining({ state: 'done', prompt: 'new turn', agentType: 'grok' })
      ])
    } finally {
      firstServer.stop()
      restoredServer.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
