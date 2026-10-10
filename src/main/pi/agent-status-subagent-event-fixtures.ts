import { vi } from 'vitest'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { normalizeAndAccept } from '../../shared/agent-hook-listener-test-harness'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'

import {
  AGENT_STATUS_EXTENSION_SELF_PID,
  type AgentStatusExtensionHarness
} from './agent-status-extension-test-harness'

// Event shapes and orderings mirror traces recorded from pi-subagents 0.71.0.
export const WORKFLOW = 'workflow-1'
export const idle = { isIdle: () => true }

type PostedChild = { id: string; state: string; startedAt: number; agentType?: string }
type PostedPayload = {
  hook_event_name: string
  session_id?: string
  session_file?: string
  subagents?: PostedChild[]
}

export function posts(harness: AgentStatusExtensionHarness): PostedPayload[] {
  return harness.fetchMock.mock.calls.map((call) => {
    const body: { payload: PostedPayload } = JSON.parse(String(call[1]?.body))
    return body.payload
  })
}

export function normalizedOmpPosts(harness: AgentStatusExtensionHarness): AgentHookEventPayload[] {
  const state = createHookListenerState()
  const rows: AgentHookEventPayload[] = []
  for (const payload of posts(harness)) {
    const row = normalizeAndAccept(state, 'omp', payload)
    if (row) {
      rows.push(row)
    }
  }
  return rows
}

export function postedHookNames(harness: AgentStatusExtensionHarness): string[] {
  return posts(harness).map((post) => post.hook_event_name)
}

export function agentEndCount(harness: AgentStatusExtensionHarness): number {
  return postedHookNames(harness).filter((name) => name === 'agent_end').length
}

export function startWorkflow(harness: AgentStatusExtensionHarness): void {
  harness.emitPiEvent('subagent:async-started', {
    id: WORKFLOW,
    mode: 'workflow',
    agent: 'workflow',
    pid: AGENT_STATUS_EXTENSION_SELF_PID
  })
}

export function startChild(
  harness: AgentStatusExtensionHarness,
  id: string,
  parent = WORKFLOW
): void {
  harness.emitPiEvent('subagent:async-started', {
    id,
    mode: 'single',
    pid: 4000,
    parentWorkflowRunId: parent
  })
}

export function exitRunner(harness: AgentStatusExtensionHarness, runId: string): void {
  harness.emitPiEvent('subagent:process-terminal', { runId, state: 'observed' })
}

export function complete(harness: AgentStatusExtensionHarness, id: string): void {
  harness.emitPiEvent('subagent:async-complete', { id, runId: id, state: 'complete' })
}

export function childIds(payload: PostedPayload | undefined): string[] | undefined {
  return payload?.subagents?.map((child) => child.id)
}

export function startAsync(harness: AgentStatusExtensionHarness, id: string, agent: string): void {
  harness.emitPiEvent('subagent:async-started', {
    id,
    mode: 'single',
    agent,
    task: '[REDACTED]',
    goal: '[REDACTED]',
    pid: 4000
  })
}

export async function endTurn(harness: AgentStatusExtensionHarness): Promise<void> {
  await harness.callHook('agent_end', {}, idle)
  await harness.callHook('agent_settled', undefined, idle)
  await vi.advanceTimersByTimeAsync(0)
}
