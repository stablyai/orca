import { describe, expect, it } from 'vitest'

import type { AgentChildWorkEvidence } from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { createAgentStatusExtensionHarness } from '../managed-extensions/agent-status/agent-status-extension-test-harness'
import { PiRpcSubagents } from './rpc-subagents'

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}

// Native chat Pi has no hook endpoint; the managed extension's roster must still reach the chat.
describe('Pi native chat subagents', () => {
  it('reports subagents the managed extension observes and settles them with their outcome', async () => {
    const harness = createAgentStatusExtensionHarness({
      kind: 'pi',
      env: { ORCA_STRUCTURED_SESSION: '1', ORCA_PANE_KEY: undefined }
    })
    const evidence: AgentChildWorkEvidence[] = []
    const subagents = new PiRpcSubagents((edges) => evidence.push(...edges))
    const ui = {
      setStatus: (statusKey: string, statusText: string | undefined) => {
        subagents.receive({
          type: 'extension_ui_request',
          method: 'setStatus',
          statusKey,
          statusText
        })
      }
    }
    await harness.callHook('session_start', { reason: 'startup' }, { ui })
    await harness.callHook('agent_start', undefined, { ui })

    harness.emitPiEvent('subagent:async-started', { id: 'run-a', agent: 'scout' })
    harness.emitPiEvent('subagent:async-started', { id: 'run-b', agent: 'worker' })
    await flush()
    expect(evidence.findLast((edge) => edge.type === 'live')).toMatchObject({
      child: { handle: { id: 'run-b' }, kind: 'agent', agentType: 'worker', state: 'working' }
    })

    // The parent turn ends while both children still run.
    await harness.callHook('agent_end', undefined, { ui, isIdle: () => true })
    await harness.callHook('agent_settled', undefined, { ui })
    // A's runner exits before A reports its own outcome.
    harness.emitPiEvent('subagent:process-terminal', { runId: 'run-a', state: 'observed' })
    harness.emitPiEvent('subagent:async-complete', {
      id: 'run-b',
      runId: 'run-b',
      success: false,
      state: 'stopped'
    })
    await flush()
    harness.emitPiEvent('subagent:async-complete', { id: 'run-a', runId: 'run-a', success: true })
    await flush()
    const outcomes = Object.fromEntries(
      evidence.flatMap((edge) => (edge.type === 'ended' ? [[edge.handle.id, edge.outcome]] : []))
    )
    expect(outcomes).toEqual({ 'run-a': 'succeeded', 'run-b': 'cancelled' })

    harness.emitPiEvent('subagent:async-started', { id: 'run-c', agent: 'worker' })
    await flush()
    expect(evidence.at(-1)).toMatchObject({ type: 'live', child: { handle: { id: 'run-c' } } })

    subagents.end()
    expect(evidence.at(-1)).toMatchObject({ type: 'session-ended' })
  })
})
