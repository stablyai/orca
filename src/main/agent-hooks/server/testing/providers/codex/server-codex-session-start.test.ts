import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from '../../../../../../wsl-guest/agent-hook-server'
import { AgentHookServer } from '../../../agent-hook-server'
import { selectFreshExplicitAgentStatus } from '../../../../../runtime/workspaces/process-listing/runtime-hook-agent-row-selection'
import { buildBody, postHookEvent, PANE } from '../../server.test-fixtures'

it.each(['local', 'relay', 'old-relay', 'old-relay-no-main'] as const)(
  'separates Codex session identity from live turns on %s',
  async (route) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    const directory = mkdtempSync(join(tmpdir(), 'codex-session-start-'))
    const desktop = new AgentHookServer()
    const relay =
      route === 'local'
        ? undefined
        : new RelayAgentHookServer({
            endpointDir: directory,
            forward: (event) =>
              desktop.ingestRemote(
                route.startsWith('old-') && event.hookEventName === 'SessionStart'
                  ? {
                      ...event,
                      payload: {
                        ...event.payload,
                        state: 'working',
                        sessionBoundary: undefined,
                        mainAgent:
                          route === 'old-relay-no-main'
                            ? undefined
                            : { state: 'working', stateStartedAt: 900 }
                      }
                    }
                  : event,
                'ssh-connection'
              )
          })
    await desktop.start({ env: 'production' })
    await relay?.start()
    async function post(payload: Record<string, unknown>): Promise<void> {
      const body = buildBody({ session_id: 'root-session', ...payload })
      const coordinates = relay?.getCoordinates()
      const response = coordinates
        ? await fetch(`http://127.0.0.1:${coordinates.port}/hook/codex`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Connection: 'close',
              'X-Orca-Agent-Hook-Token': coordinates.token
            },
            body: JSON.stringify(body)
          })
        : await postHookEvent(desktop, body, '/hook/codex')
      expect(response.status).toBe(204)
    }
    try {
      await post({ hook_event_name: 'SessionStart', source: 'startup' })
      expect(desktop.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        sessionBoundary: true,
        mainAgent: { state: 'done' }
      })
      expect(desktop.getStatusSnapshot()[0].turnStartedAt).toBeUndefined()
      expect(desktop.getStatusSnapshot()[0].turnEndedAt).toBeUndefined()
      await post({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: 'review' })
      await post({ hook_event_name: 'SubagentStart', agent_id: 'child-session' })
      vi.setSystemTime(2_000)
      await post({ hook_event_name: 'SessionStart', source: 'compact' })
      expect(desktop.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        prompt: 'review',
        turnStartedAt: 1_000,
        mainAgent: { state: 'working', stateStartedAt: 1_000 },
        subagents: [{ id: 'child-session', state: 'working' }],
        providerSession: { id: 'root-session' }
      })
      await post({ hook_event_name: 'SessionStart', source: 'future-continuation' })
      expect(desktop.getStatusSnapshot()[0].mainAgent).toMatchObject({ stateStartedAt: 1_000 })
      // A schema-shaped legacy child start must not take over its parent's row.
      await post({
        hook_event_name: 'SessionStart',
        source: 'resume',
        session_id: 'child-session',
        transcript_path: join(directory, 'child-rollout.jsonl')
      })
      expect(desktop.getStatusSnapshot()[0]).toMatchObject({
        mainAgent: { state: 'working', stateStartedAt: 1_000 },
        providerSession: { id: 'root-session' }
      })
      if (route === 'local') {
        vi.setSystemTime(2_500)
        await post({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: 'review' })
        expect(desktop.getStatusSnapshot()[0].mainAgent).toMatchObject({ stateStartedAt: 1_000 })
      }
      vi.setSystemTime(3_000)
      await post({
        hook_event_name: 'PreToolUse',
        tool_name: 'request_user_input',
        tool_input: { questions: [] }
      })
      vi.setSystemTime(4_000)
      await post({ hook_event_name: 'SessionStart', source: 'compact' })
      expect(desktop.getStatusSnapshot()[0]).toMatchObject({
        state: 'waiting',
        prompt: 'review',
        toolName: 'request_user_input',
        mainAgent: { state: 'waiting', stateStartedAt: 3_000 },
        subagents: [{ id: 'child-session', state: 'working' }]
      })
      if (route === 'local' || route === 'relay') {
        vi.setSystemTime(5_000)
        await post({ hook_event_name: 'PostToolUse', tool_name: 'Bash' })
        vi.setSystemTime(6_000)
        await post({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-2', prompt: 'next turn' })
        expect(desktop.getStatusSnapshot()[0].mainAgent).toMatchObject({ stateStartedAt: 6_000 })
        await post({ hook_event_name: 'Stop' })
        await post({ hook_event_name: 'SubagentStart', agent_id: 'child-session' })
        expect(desktop.getStatusSnapshot()[0]).toMatchObject({
          state: 'working',
          mainAgent: { state: 'done', stateStartedAt: 6_000 },
          subagents: [{ id: 'child-session', state: 'working' }]
        })
        vi.setSystemTime(7_000)
        await post({ hook_event_name: 'SessionStart', source: 'compact' })
        expect(desktop.getStatusSnapshot()[0]).toMatchObject({
          state: 'working',
          mainAgent: { state: 'done', stateStartedAt: 6_000 },
          subagents: [{ id: 'child-session', state: 'working' }]
        })
        await post({ hook_event_name: 'SubagentStop', agent_id: 'child-session' })
        await post({ hook_event_name: 'Interrupt' })
        vi.setSystemTime(8_000)
        await post({ hook_event_name: 'SessionStart', source: 'compact' })
        expect(desktop.getStatusSnapshot()[0]).toMatchObject({
          state: 'done',
          sessionBoundary: true,
          mainAgent: { state: 'done', stateStartedAt: 6_000, outcome: 'cancellation' }
        })
        await post({ hook_event_name: 'UserPromptSubmit', prompt: 'old session work' })
        await post({
          hook_event_name: 'SessionStart',
          source: 'startup',
          session_id: 'replacement-session',
          transcript_path: join(directory, 'replacement.jsonl')
        })
        expect(desktop.getStatusSnapshot()[0]).toMatchObject({
          state: 'done',
          sessionBoundary: true,
          mainAgent: { state: 'done' },
          providerSession: { id: 'replacement-session' }
        })
        await post({
          hook_event_name: 'UserPromptSubmit',
          session_id: 'replacement-session',
          prompt: 'replacement task'
        })
        expect(desktop.getStatusSnapshot()[0]).toMatchObject({
          state: 'working',
          prompt: 'replacement task'
        })
      }
    } finally {
      relay?.stop()
      desktop.stop()
      vi.useRealTimers()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

it('does not confirm restored work from an older relay startup or redate a submitted replay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-restored-start-'))
  const first = new AgentHookServer()
  const desktop = new AgentHookServer()
  const event = {
    paneKey: PANE,
    source: 'codex' as const,
    providerSession: { key: 'session_id' as const, id: 'root-session' },
    payload: {
      state: 'working' as const,
      agentType: 'codex' as const,
      prompt: 'old task',
      mainAgent: { state: 'working' as const, stateStartedAt: 1_000 }
    }
  }
  try {
    await first.start({ env: 'production', userDataPath: directory })
    first.ingestRemote({ ...event, hookEventName: 'UserPromptSubmit' }, 'ssh-connection')
    first.flushStatusPersistSync()
    first.stop()
    await desktop.start({ env: 'production', userDataPath: directory })
    expect(desktop.getStatusSnapshot()[0].restoredUnconfirmed).toBe(true)
    desktop.ingestRemote({ ...event, hookEventName: 'SessionStart' }, 'ssh-connection')
    expect(desktop.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      restoredUnconfirmed: true,
      providerSession: { id: 'root-session' },
      mainAgent: { state: 'working', stateStartedAt: 1_000 }
    })
    desktop.ingestRemote(
      {
        ...event,
        hookEventName: 'SessionStart',
        hasExplicitPrompt: true,
        isReplay: true
      },
      'ssh-connection'
    )
    expect(desktop.getStatusSnapshot()[0].restoredUnconfirmed).toBe(true)
    desktop.ingestRemote(
      {
        ...event,
        hookEventName: 'SubagentStart',
        toolAgentId: 'child-1',
        payload: {
          ...event.payload,
          subagents: [{ id: 'child-1', state: 'working', startedAt: 1_000 }]
        }
      },
      'ssh-connection'
    )
    expect(desktop.getStatusSnapshot()[0]).toMatchObject({
      restoredUnconfirmed: true,
      subagents: [{ id: 'child-1', state: 'working' }]
    })
    desktop.ingestRemote(
      {
        ...event,
        hookEventName: 'UserPromptSubmit',
        hasExplicitPrompt: true,
        payload: { ...event.payload, mainAgent: { state: 'working', stateStartedAt: 6_000 } }
      },
      'ssh-connection'
    )
    expect(desktop.getStatusSnapshot()[0].restoredUnconfirmed).toBeUndefined()
    desktop.ingestRemote(
      {
        ...event,
        hookEventName: 'Interrupt',
        payload: {
          ...event.payload,
          state: 'done',
          mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: 7_000 }
        }
      },
      'ssh-connection'
    )
    const stopped = desktop.getStatusSnapshot()[0]
    expect(stopped.mainAgent).toMatchObject({ state: 'done', outcome: 'cancellation' })
    desktop.ingestRemote(
      { ...event, hookEventName: 'SessionStart', hasExplicitPrompt: true, isReplay: true },
      'ssh-connection'
    )
    expect(desktop.getStatusSnapshot()[0]).toEqual(stopped)
    expect(
      selectFreshExplicitAgentStatus({
        handle: 'fixture',
        paneKey: PANE,
        hookRows: desktop.getStatusSnapshot()
      })?.mainAgentWorkingStartedAt
    ).toBeNull()
  } finally {
    first.stop()
    desktop.stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
