import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AGENT_STATUS_EXTENSION_SELF_PID,
  createAgentStatusExtensionHarness,
  type AgentStatusExtensionHarness
} from './agent-status-extension-test-harness'

// Event shapes and orderings mirror traces recorded from pi-subagents 0.71.0.
const WORKFLOW = 'workflow-1'
const idle = { isIdle: () => true }

function postedHookNames(harness: AgentStatusExtensionHarness): string[] {
  return harness.fetchMock.mock.calls.map((call) => {
    const body: { payload?: { hook_event_name?: unknown } } = JSON.parse(String(call[1]?.body))
    return String(body.payload?.hook_event_name)
  })
}

function agentEndCount(harness: AgentStatusExtensionHarness): number {
  return postedHookNames(harness).filter((name) => name === 'agent_end').length
}

function startWorkflow(harness: AgentStatusExtensionHarness): void {
  harness.emitPiEvent('subagent:async-started', {
    id: WORKFLOW,
    mode: 'workflow',
    pid: AGENT_STATUS_EXTENSION_SELF_PID
  })
}

function startChild(harness: AgentStatusExtensionHarness, id: string, parent = WORKFLOW): void {
  harness.emitPiEvent('subagent:async-started', {
    id,
    mode: 'single',
    pid: 4000,
    parentWorkflowRunId: parent
  })
}

function exitRunner(harness: AgentStatusExtensionHarness, runId: string): void {
  harness.emitPiEvent('subagent:process-terminal', { runId, state: 'observed' })
}

function complete(harness: AgentStatusExtensionHarness, id: string): void {
  harness.emitPiEvent('subagent:async-complete', { id, runId: id, state: 'complete' })
}

async function endTurn(harness: AgentStatusExtensionHarness): Promise<void> {
  await harness.callHook('agent_end', {}, idle)
  await harness.callHook('agent_settled', undefined, idle)
  await vi.advanceTimersByTimeAsync(0)
}

describe('Pi async subagent roster', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('settles after an async workflow whose awaited children never report completion', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startWorkflow(harness)
    startChild(harness, 'child-a')
    startChild(harness, 'child-b')
    await endTurn(harness)
    exitRunner(harness, 'child-a')
    exitRunner(harness, 'child-b')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(agentEndCount(harness)).toBe(0)

    // pi-subagents wakes the lead just before announcing only the workflow's completion.
    await harness.callHook('agent_start')
    complete(harness, WORKFLOW)
    await endTurn(harness)

    expect(postedHookNames(harness).at(-1)).toBe('agent_end')
  })

  it('settles as soon as the workflow completes when its children already exited', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startWorkflow(harness)
    startChild(harness, 'child-a')
    await endTurn(harness)
    exitRunner(harness, 'child-a')
    complete(harness, WORKFLOW)
    await vi.advanceTimersByTimeAsync(0)

    expect(agentEndCount(harness)).toBe(1)
  })

  it('settles after a foreground workflow whose awaited children never report completion', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startChild(harness, 'child-a', 'tool-call-1')
    startChild(harness, 'child-b', 'tool-call-1')
    exitRunner(harness, 'child-a')
    exitRunner(harness, 'child-b')
    await endTurn(harness)

    expect(agentEndCount(harness)).toBe(1)
  })

  it('settles once a child runner exits after its workflow already completed', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startWorkflow(harness)
    startChild(harness, 'child-a')
    await endTurn(harness)
    complete(harness, WORKFLOW)
    exitRunner(harness, 'child-a')
    await vi.advanceTimersByTimeAsync(500)
    expect(agentEndCount(harness)).toBe(0)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(agentEndCount(harness)).toBe(1)
  })

  it('keeps working while an explicit async child outlives its workflow', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startWorkflow(harness)
    startChild(harness, 'child-a')
    complete(harness, WORKFLOW)
    await endTurn(harness)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(agentEndCount(harness)).toBe(0)

    // The child's own completion and the wake turn land right after its runner exits.
    exitRunner(harness, 'child-a')
    await vi.advanceTimersByTimeAsync(150)
    await harness.callHook('agent_start')
    complete(harness, 'child-a')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(agentEndCount(harness)).toBe(0)

    await endTurn(harness)
    expect(agentEndCount(harness)).toBe(1)
  })

  it('ignores runner exits for runs it is not tracking', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    harness.emitPiEvent('subagent:async-started', { id: 'run-1', mode: 'single', pid: 4000 })
    await endTurn(harness)
    exitRunner(harness, 'other-run')
    harness.emitPiEvent('subagent:process-terminal', {})
    await vi.advanceTimersByTimeAsync(5_000)

    expect(agentEndCount(harness)).toBe(0)
  })

  it('accepts completion events that identify the run only by runId', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    harness.emitPiEvent('subagent:async-started', { id: 'run-1', mode: 'single', pid: 4000 })
    await endTurn(harness)
    harness.emitPiEvent('subagent:async-complete', { runId: 'run-1' })
    await vi.advanceTimersByTimeAsync(0)

    expect(agentEndCount(harness)).toBe(1)
  })

  it('keeps one runner-exit subscription and the roster across reloads', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startChild(harness, 'child-a', 'tool-call-1')
    harness.reload()
    expect(harness.piEventListenerCount('subagent:process-terminal')).toBe(1)

    exitRunner(harness, 'child-a')
    await endTurn(harness)
    expect(agentEndCount(harness)).toBe(1)
  })
})
