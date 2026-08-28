import { describe, expect, it } from 'vitest'
import { TERMINAL_QUICK_COMMAND_AGENT_DRAFTS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import { projectTerminalQuickCommandsForClient } from './terminal-quick-command-client-projection'

const commands: TerminalQuickCommand[] = [
  {
    id: 'review',
    label: 'Review',
    action: 'agent-prompt',
    agent: 'codex',
    prompt: 'Review this diff',
    submitPrompt: false
  }
]

describe('projectTerminalQuickCommandsForClient', () => {
  it('preserves Agent draft state for current and capable clients', () => {
    expect(projectTerminalQuickCommandsForClient(commands, undefined)).toEqual(commands)
    expect(
      projectTerminalQuickCommandsForClient(commands, [
        TERMINAL_QUICK_COMMAND_AGENT_DRAFTS_RUNTIME_CAPABILITY
      ])
    ).toEqual(commands)
  })

  it('omits Agent draft state for older exact-shape clients', () => {
    expect(projectTerminalQuickCommandsForClient(commands, [])).toEqual([
      {
        id: 'review',
        label: 'Review',
        action: 'agent-prompt',
        agent: 'codex',
        prompt: 'Review this diff'
      }
    ])
  })
})
