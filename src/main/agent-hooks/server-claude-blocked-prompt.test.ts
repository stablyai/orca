import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import { createProgramStatusProjector } from '../../shared/program-status/agent-status-projector'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

let server: AgentHookServer
let projector: ReturnType<typeof createProgramStatusProjector>

beforeEach(async () => {
  _internals.resetCachesForTests()
  server = new AgentHookServer()
  await server.start({ env: 'production' })
  projector = createProgramStatusProjector()
})

afterEach(() => {
  server.stop()
  vi.restoreAllMocks()
})

// Claude Code 2.1.314 reports `working` then `idle` (no `done`, no Stop hook) when a prompt hook blocks.
function program(state: 'working' | 'idle' | 'done', app = 'claude-code'): void {
  const { payloads, facet } = projector.process(`\x1b]7501;state=${state}:app=${app}\x1b\\`)
  if (facet !== undefined) {
    server.ingestProgramStatusFacet({ paneKey: PANE, facet })
  }
  for (const { payload } of payloads) {
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      fromProgramStatus: true,
      payload
    })
  }
}

async function hook(payload: Record<string, unknown>): Promise<void> {
  const response = await postHookEvent(server, buildBody({ session_id: 'session-1', ...payload }))
  expect(response.status).toBe(204)
}

function promptHook(prompt = 'hello'): Promise<void> {
  return hook({ hook_event_name: 'UserPromptSubmit', prompt })
}

function row() {
  return server.getStatusSnapshotForPane(PANE)[0]
}

function expectSettledLikeStop(): void {
  expect(row()).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
  expect(row().interrupted).toBeUndefined()
  expect(row().mainAgent?.outcome).toBeUndefined()
}

describe('Claude prompt blocked by a UserPromptSubmit hook', () => {
  beforeEach(() => {
    program('idle')
  })

  it('settles when the idle lands after the prompt hook', async () => {
    program('working')
    await promptHook()
    expect(row().state).toBe('working')
    program('idle')
    expectSettledLikeStop()
  })

  it('settles when the idle lands before the prompt hook', async () => {
    program('working')
    program('idle')
    await promptHook()
    expectSettledLikeStop()
  })

  it("ignores another program's idle in the same pane", async () => {
    program('working')
    await promptHook()
    program('idle', 'codex')
    expect(row().state).toBe('working')
  })

  it('leaves a run stopped with Ctrl+C to the interrupt verdict', async () => {
    program('working')
    await promptHook()
    server.observeClaudeTerminalEvidence(PANE, { kind: 'input', data: '\x03' })
    program('idle')
    const baseline = row()
    expect(baseline.state).toBe('working')
    server.inferInterrupt({
      paneKey: PANE,
      baselineUpdatedAt: baseline.receivedAt,
      baselineStateStartedAt: baseline.stateStartedAt,
      baselinePrompt: baseline.prompt,
      baselineAgentType: 'claude',
      intent: 'ctrl-c'
    })
    expect(row()).toMatchObject({ state: 'done', interrupted: true })
  })

  it('keeps a typed prompt working when its hook lands before its working report', async () => {
    program('working')
    program('idle')
    server.observeClaudeTerminalEvidence(PANE, { kind: 'input', data: 'next prompt\r' })
    await promptHook('next prompt')
    expect(row()).toMatchObject({ state: 'working', prompt: 'next prompt' })
  })

  it('keeps the next prompt working when its hook lands before its working report', async () => {
    program('working')
    await promptHook('blocked')
    program('idle')
    await promptHook('allowed')
    expect(row()).toMatchObject({ state: 'working', prompt: 'allowed' })
    program('working')
    expect(row().state).toBe('working')
  })
})
