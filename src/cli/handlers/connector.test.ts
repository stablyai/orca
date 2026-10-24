import { describe, expect, it } from 'vitest'
import { RuntimeClientError } from '../runtime-client'
import {
  callConnector,
  formatConnectorStart,
  formatDelivery,
  formatPendingPrompt
} from './connector'

function refusingClient(code: string) {
  return {
    call: async (): Promise<never> => {
      throw new RuntimeClientError(code, code)
    }
  }
}

describe('orca connector', () => {
  it('passes the host’s connectors_disabled refusal through, with no local flag check', async () => {
    await expect(
      callConnector(refusingClient('connectors_disabled'), 'connector.send', {})
    ).rejects.toMatchObject({ code: 'connectors_disabled' })
  })

  it('names the update instead of surfacing method_not_found from an older host', async () => {
    await expect(
      callConnector(refusingClient('method_not_found'), 'connector.send', {})
    ).rejects.toThrow('Update Orca on the host')
  })

  it('claims a start only for a definite answer', () => {
    expect(formatConnectorStart({ outcome: 'accepted' })).toBe('started; prompt accepted')
    expect(formatConnectorStart({ outcome: 'refused', reason: 'unsupported_agent' })).toBe(
      'not started; prompt refused: unsupported_agent'
    )
    expect(formatConnectorStart({ outcome: 'unknown', reason: 'replayed_after_restart' })).toBe(
      'prompt unknown: replayed_after_restart'
    )
  })

  it('says when a send reopened a closed agent', () => {
    expect(formatDelivery({ outcome: 'accepted', reopened: true })).toBe(
      'accepted (reopened the agent)'
    )
    expect(formatDelivery({ outcome: 'refused', reason: 'agent_asleep_in_window' })).toBe(
      'refused: agent_asleep_in_window'
    )
  })

  it('prints a prompt with its id and options, and an unknown kind as one to answer in Orca', () => {
    expect(
      formatPendingPrompt({
        kind: 'approval',
        promptId: 'p_1',
        tool: 'Bash',
        summary: 'ls',
        options: [
          { id: 'allow_once', label: 'Allow once' },
          { id: 'reject_once', label: 'Reject' }
        ]
      })
    ).toBe('approval Bash: ls\n  prompt id: p_1\n  allow_once: Allow once\n  reject_once: Reject')
    expect(formatPendingPrompt({ kind: 'free-text', promptId: 'p_2' })).toBe(
      'unsupported (answer in Orca)\n  prompt id: p_2'
    )
    expect(formatPendingPrompt(null)).toBe('no pending prompt')
  })
})
