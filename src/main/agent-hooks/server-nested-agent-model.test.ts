import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({
  track: vi.fn()
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

type StatusPayload = {
  state: 'working' | 'done'
  prompt: string
  agentType: string
  model?: string
}

function ingest(server: AgentHookServer, at: number, payload: StatusPayload): void {
  vi.setSystemTime(at)
  server.ingestRemote(
    { paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1', hasExplicitPrompt: true, payload },
    'conn-1'
  )
}

beforeEach(() => {
  _internals.resetCachesForTests()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('AgentHookServer nested agent model fence', () => {
  // Why: `claude` running `codex exec` fires codex hooks on the inherited pane key.
  it('keeps the parent model when a nested hook reports its own model', () => {
    const server = new AgentHookServer()
    ingest(server, 1_000, {
      state: 'working',
      prompt: 'parent claude',
      agentType: 'claude',
      model: 'claude-fable-5'
    })
    ingest(server, 1_100, {
      state: 'working',
      prompt: 'nested codex',
      agentType: 'codex',
      model: 'gpt-6-astra'
    })

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: PANE, agentType: 'claude', model: 'claude-fable-5' })
    ])
  })

  it('drops the nested model when the fenced parent never reported one', () => {
    const server = new AgentHookServer()
    ingest(server, 1_000, { state: 'working', prompt: 'parent claude', agentType: 'claude' })
    ingest(server, 1_100, {
      state: 'working',
      prompt: 'nested codex',
      agentType: 'codex',
      model: 'gpt-6-astra'
    })

    const [row] = server.getStatusSnapshot()
    expect(row).toMatchObject({ agentType: 'claude' })
    expect(row?.model).toBeUndefined()
  })

  it("keeps a codex parent's model through a nested model-less hook", () => {
    const server = new AgentHookServer()
    ingest(server, 1_000, {
      state: 'working',
      prompt: 'parent codex',
      agentType: 'codex',
      model: 'gpt-6-astra'
    })
    ingest(server, 1_100, { state: 'working', prompt: 'nested claude', agentType: 'claude' })

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ agentType: 'codex', model: 'gpt-6-astra' })
    ])
  })

  it('still updates the label on a genuine model switch by the same agent', () => {
    const server = new AgentHookServer()
    ingest(server, 1_000, {
      state: 'working',
      prompt: 'first',
      agentType: 'claude',
      model: 'claude-fable-5'
    })
    ingest(server, 1_100, {
      state: 'working',
      prompt: 'second',
      agentType: 'claude',
      model: 'claude-opus-5-5'
    })

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ agentType: 'claude', model: 'claude-opus-5-5' })
    ])
  })

  it("shows a codex pane's own model", () => {
    const server = new AgentHookServer()
    ingest(server, 1_000, {
      state: 'working',
      prompt: 'codex turn',
      agentType: 'codex',
      model: 'gpt-6-astra'
    })

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ agentType: 'codex', model: 'gpt-6-astra' })
    ])
  })

  it('lets a new agent claim the pane with its model once the parent turn is done', () => {
    const server = new AgentHookServer()
    ingest(server, 1_000, {
      state: 'done',
      prompt: 'parent claude',
      agentType: 'claude',
      model: 'claude-fable-5'
    })
    ingest(server, 1_100, {
      state: 'working',
      prompt: 'codex turn',
      agentType: 'codex',
      model: 'gpt-6-astra'
    })

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ agentType: 'codex', model: 'gpt-6-astra' })
    ])
  })

  // Why: readers retain sparse model labels, so the host must never publish a child's label on the parent.
  it('never pushes a nested codex model to the renderer from real hook bodies', async () => {
    vi.useRealTimers()
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    const pushed: { agentType?: string; model?: string }[] = []
    server.setListener((event) => pushed.push(event.payload))
    try {
      const steps: [string, Record<string, unknown>][] = [
        ['/hook/claude', { hook_event_name: 'UserPromptSubmit', session_id: 'c-1', prompt: 'p' }],
        [
          '/hook/codex',
          {
            hook_event_name: 'SessionStart',
            session_id: 'x-1',
            model: 'gpt-6-astra',
            source: 'startup'
          }
        ],
        [
          '/hook/codex',
          {
            hook_event_name: 'UserPromptSubmit',
            session_id: 'x-1',
            prompt: 'n',
            model: 'gpt-6-astra'
          }
        ],
        [
          '/hook/codex',
          {
            hook_event_name: 'PreToolUse',
            session_id: 'x-1',
            model: 'gpt-6-astra',
            tool_name: 'shell'
          }
        ],
        [
          '/hook/codex',
          {
            hook_event_name: 'Stop',
            session_id: 'x-1',
            model: 'gpt-6-astra',
            stop_hook_active: false
          }
        ],
        ['/hook/claude', { hook_event_name: 'Stop', session_id: 'c-1' }]
      ]
      for (const [path, body] of steps) {
        expect((await postHookEvent(server, buildBody(body), path)).status).toBe(204)
      }
      const [row] = server.getStatusSnapshot()
      expect(row).toMatchObject({ agentType: 'claude', state: 'done' })
      expect(row?.model).toBeUndefined()
    } finally {
      server.stop()
    }

    expect(pushed.length).toBeGreaterThanOrEqual(4)
    expect(pushed.every((payload) => payload.agentType === 'claude')).toBe(true)
    expect(pushed.map((payload) => payload.model)).not.toContain('gpt-6-astra')
  })
})
