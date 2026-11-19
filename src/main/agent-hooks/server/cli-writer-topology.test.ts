import { expect, it } from 'vitest'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { deriveCliWriterTopology, retainTmuxWriterTopology } from './cli-writer-observation'
import { cliWriterTopology } from './cli-writer-topology'

it('keeps a tmux-hosted conversation shared when an unverified writer reports it', () => {
  const providerSession = { key: 'session_id' as const, id: 'claude-in-tmux' }
  retainTmuxWriterTopology(providerSession)
  const row: AgentHookEventPayload = {
    paneKey: 'tab-1:pane-1',
    connectionId: null,
    payload: { state: 'working', prompt: '', agentType: 'claude' },
    providerSession
  }
  // No execution matcher can vouch for the writer; a pane-owned claim would be dropped here.
  expect(cliWriterTopology(deriveCliWriterTopology(row, undefined, null))).toBe('shared')
})
