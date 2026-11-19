import { expect, it } from 'vitest'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { deriveCliWriterTopology } from './cli-writer-observation'
import { cliWriterTopology } from './cli-writer-topology'

it('keeps a tmux-hosted conversation shared when an unverified writer reports it', () => {
  const row: AgentHookEventPayload = {
    paneKey: 'tab-1:pane-1',
    connectionId: null,
    executionHost: 'shared',
    payload: { state: 'working', prompt: '', agentType: 'claude' },
    providerSession: { key: 'session_id', id: 'claude-in-tmux' }
  }
  // No execution matcher can vouch for the writer; a pane-owned claim would be dropped here.
  expect(cliWriterTopology(deriveCliWriterTopology(row, undefined, null))).toBe('shared')
})
