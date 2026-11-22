import { readSavedStatus } from './last-status.test-fixtures'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../server.test-fixtures'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

describe('saved agent status cadence', () => {
  let userDataPath: string
  let server: AgentHookServer

  const lastStatusPath = (): string => join(userDataPath, 'agent-hooks', 'last-status.json')
  const readPrompt = (): unknown =>
    JSON.parse(readSavedStatus(lastStatusPath())).entries[PANE]?.payload?.prompt
  const prompt = (text: string, launchToken?: string): Promise<Response> =>
    postHookEvent(
      server,
      buildBody(
        { hook_event_name: 'UserPromptSubmit', prompt: text },
        launchToken ? { launchToken } : {}
      )
    )

  beforeEach(async () => {
    _internals.resetCachesForTests()
    // Real loopback POSTs need fake time to advance.
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ['setTimeout', 'clearTimeout', 'Date']
    })
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-persist-throttle-'))
    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
  })

  afterEach(() => {
    server.stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('commits the completed turn before quit or the next stream checkpoint', async () => {
    await prompt('inspect the workspace')
    await vi.advanceTimersByTimeAsync(1)
    await postHookEvent(
      server,
      buildBody({ hook_event_name: 'Stop', last_assistant_message: 'inspection finished' })
    )
    await vi.advanceTimersByTimeAsync(1)
    expect(JSON.parse(readSavedStatus(lastStatusPath())).entries[PANE].payload).toMatchObject({
      state: 'done',
      prompt: 'inspect the workspace',
      lastAssistantMessage: 'inspection finished'
    })
  })

  it('commits a finished lead reply while its child still holds the session working', async () => {
    const identity = {
      paneKey: PANE,
      source: 'codex' as const,
      providerSession: { key: 'session_id' as const, id: 'child-held-session' }
    }
    server.ingestRemote(
      {
        ...identity,
        hookEventName: 'UserPromptSubmit',
        hasExplicitPrompt: true,
        payload: {
          agentType: 'codex',
          state: 'working',
          prompt: 'inspect the workspace',
          mainAgent: { state: 'working', stateStartedAt: 1_000 }
        }
      },
      'ssh-a'
    )
    await vi.advanceTimersByTimeAsync(1)
    server.ingestRemote(
      {
        ...identity,
        hookEventName: 'Stop',
        payload: {
          agentType: 'codex',
          state: 'working',
          prompt: 'inspect the workspace',
          mainAgent: { state: 'done', stateStartedAt: 2_000 },
          subagents: [{ id: 'child', state: 'working', startedAt: 1_000 }],
          lastAssistantMessage: 'lead inspection finished'
        }
      },
      'ssh-a'
    )
    await vi.advanceTimersByTimeAsync(1)
    expect(JSON.parse(readSavedStatus(lastStatusPath())).entries[PANE].payload).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done' },
      lastAssistantMessage: 'lead inspection finished'
    })
  })

  it('commits a new turn that repeats the finished prompt', async () => {
    await prompt('inspect the workspace')
    await vi.advanceTimersByTimeAsync(1)
    await postHookEvent(server, buildBody({ hook_event_name: 'Stop' }))
    await vi.advanceTimersByTimeAsync(1)
    await prompt('inspect the workspace')
    await vi.advanceTimersByTimeAsync(1)
    expect(JSON.parse(readSavedStatus(lastStatusPath())).entries[PANE].payload).toMatchObject({
      state: 'working',
      prompt: 'inspect the workspace'
    })
  })

  it('commits a prompt submitted while the previous turn is still working', async () => {
    await prompt('first request')
    await vi.advanceTimersByTimeAsync(1)
    await prompt('follow-up request')
    await vi.advanceTimersByTimeAsync(1)
    expect(readPrompt()).toBe('follow-up request')
  })

  it('commits a Claude prompt that lands after its turn opened', async () => {
    const claude = (payload: Record<string, unknown>): Promise<Response> =>
      postHookEvent(
        server,
        buildBody({
          session_id: 'session-a',
          prompt_id: '0b6f1a52-2f43-4f0e-9d55-0c9f6a1e2b31',
          ...payload
        })
      )
    await claude({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1' })
    await vi.advanceTimersByTimeAsync(1)
    await claude({ hook_event_name: 'UserPromptSubmit', prompt: 'inspect the workspace' })
    await vi.advanceTimersByTimeAsync(1)
    expect(readPrompt()).toBe('inspect the workspace')
  })

  it('commits a turn completion carried by a working row without a main-agent fact', async () => {
    const identity = {
      paneKey: PANE,
      source: 'claude' as const,
      providerSession: { key: 'session_id' as const, id: 'background-session' }
    }
    const working = { agentType: 'claude' as const, state: 'working' as const, prompt: 'build' }
    server.ingestRemote({ ...identity, hookEventName: 'PreToolUse', payload: working }, 'ssh-a')
    await vi.advanceTimersByTimeAsync(1)
    server.ingestRemote(
      {
        ...identity,
        hookEventName: 'Stop',
        payload: { ...working, turnCompletedAt: 5_000, lastAssistantMessage: 'build started' }
      },
      'ssh-a'
    )
    await vi.advanceTimersByTimeAsync(1)
    expect(JSON.parse(readSavedStatus(lastStatusPath())).entries[PANE].payload).toMatchObject({
      state: 'working',
      turnCompletedAt: 5_000,
      lastAssistantMessage: 'build started'
    })
  })
})
