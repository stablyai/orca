import { describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../agent-hooks/server'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AGENT_HOOK_INFER_INTERRUPT_METHOD } from '../../shared/agent-hook-interrupt-reconciliation'
import { bindRemoteClaudeInterruptReconciliation } from './ssh-agent-hook-interrupt-reconciliation'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))
const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const REVISION = '11111111-1111-4111-8111-111111111112'

function host(revision: string | undefined) {
  const server = new AgentHookServer()
  server.ingestRemote(
    {
      paneKey: PANE,
      tabId: 'tab-1',
      source: 'claude',
      launchToken: 'launch-a',
      hostTurnRevision: revision,
      providerSession: { key: 'session_id', id: 'session-a' },
      hookEventName: 'UserPromptSubmit',
      payload: {
        state: 'working',
        prompt: 'do work',
        agentType: 'claude',
        mainAgent: { state: 'working', stateStartedAt: Date.now() }
      }
    },
    'ssh-owner'
  )
  const infer = () => {
    const row = server.getStatusSnapshotForPane(PANE)[0]
    if (!row) {
      throw new Error('Missing row')
    }
    return server.inferInterrupt({
      paneKey: PANE,
      baselineUpdatedAt: row.receivedAt,
      baselineStateStartedAt: row.stateStartedAt,
      baselinePrompt: row.prompt,
      baselineAgentType: row.agentType,
      intent: 'ctrl-c'
    })
  }
  return { server, infer }
}

describe('remote interrupt mux and version fences', () => {
  it.each(['current', 'foreign', 'replaced', 'disposed', 'unsubscribed', 'legacy'])(
    '%s mux dispatches only with a matching current host proof',
    (scope) => {
      const { server, infer } = host(scope === 'legacy' ? undefined : REVISION)
      const request = vi.fn().mockResolvedValue({ applied: true })
      const mux = { request, isDisposed: () => scope === 'disposed' }
      const unsubscribe = bindRemoteClaudeInterruptReconciliation(
        server,
        mux,
        scope === 'foreign' ? 'other-host' : 'ssh-owner',
        () => scope !== 'replaced'
      )
      try {
        if (scope === 'unsubscribed') {
          unsubscribe()
        }
        expect(infer()).toBe(true)
        if (scope === 'current') {
          expect(request).toHaveBeenCalledExactlyOnceWith(AGENT_HOOK_INFER_INTERRUPT_METHOD, {
            paneKey: PANE,
            hostTurnRevision: REVISION,
            launchToken: 'launch-a',
            providerSession: { key: 'session_id', id: 'session-a' },
            intent: 'ctrl-c'
          })
        } else {
          expect(request).not.toHaveBeenCalled()
        }
      } finally {
        unsubscribe()
        server.stop()
      }
    }
  )
})
