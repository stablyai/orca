import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { PANE } from './server.test-fixtures'

afterEach(() => {
  _internals.resetCachesForTests()
  vi.useRealTimers()
})

describe('Codex Ctrl+C status inference', () => {
  it.each([null, 'ssh-connection'])('preserves working status on host %s', (connectionId) => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'folder-1',
        hookEventName: 'UserPromptSubmit',
        payload: { state: 'working', prompt: 'main task', agentType: 'codex' }
      },
      connectionId
    )
    const baseline = server.getStatusSnapshot()[0]
    const request = {
      paneKey: PANE,
      baselineUpdatedAt: baseline.receivedAt,
      baselineStateStartedAt: baseline.stateStartedAt,
      baselinePrompt: baseline.prompt,
      baselineAgentType: baseline.agentType,
      intent: 'ctrl-c' as const
    }
    vi.setSystemTime(1_500)
    expect(server.inferInterrupt(request)).toBe(false)
    expect(server.getStatusSnapshot()).toEqual([baseline])

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'folder-1',
        hookEventName: 'Stop',
        payload: { state: 'done', prompt: 'main task', agentType: 'codex' }
      },
      connectionId
    )
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done' })
    expect(server.getStatusSnapshot()[0].interrupted).toBeUndefined()
  })
})
