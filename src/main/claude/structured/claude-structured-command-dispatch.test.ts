import { describe, expect, it, vi } from 'vitest'
import { structuredAgentSessionCommandTurn } from '../../../shared/agent-session/view/structured-agent-session-command-turn-identity'
import { dispatchClaudeCommand } from './claude-structured-command-dispatch'
import { sessionFor } from './claude-structured-dispatch-test-support'

const COMMAND = {
  clientMessageId: 'compact-1',
  ...structuredAgentSessionCommandTurn('compact-1'),
  running: { kind: 'turn' as const, turnId: 'compact:compact-1', state: 'running' as const }
}

describe('dispatchClaudeCommand', () => {
  it.each([
    [undefined, '/compact'],
    ['keep the plan\nand the decisions', '/compact keep the plan\nand the decisions']
  ])('sends instructions %j as the text Claude reads as arguments', async (instructions, text) => {
    const send = vi.fn().mockRejectedValue(new Error('stop after the write'))
    await dispatchClaudeCommand(sessionFor(send), {
      ...COMMAND,
      ...(instructions ? { instructions } : {})
    }).catch(() => undefined)
    expect(JSON.stringify(send.mock.calls[0]?.[0])).toContain(JSON.stringify(text))
  })
})
