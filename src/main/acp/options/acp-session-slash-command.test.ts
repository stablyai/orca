import { expect, it } from 'vitest'
import { CURSOR_ACP_DIALECT } from '../acp-dialects/cursor-dialect'
import { COPILOT_ACP_DIALECT } from '../acp-dialects/copilot-dialect'
import { KIMI_ACP_DIALECT } from '../acp-dialects/kimi-dialect'
import { acpSessionSlashCommand } from './acp-session-slash-command'

// Rows as each agent reports them: cursor-agent 2026.11.17, Copilot 1.0.109, Kimi Code 2.6.3.
it.each([
  {
    dialect: CURSOR_ACP_DIALECT,
    command: { name: 'copy-request-id', description: 'Copy the last request ID to clipboard' },
    row: { kind: 'command', description: 'Copy the last request ID to clipboard' }
  },
  {
    dialect: CURSOR_ACP_DIALECT,
    command: { name: 'grill-me', description: 'Sharpen a plan. (user skill)' },
    row: { kind: 'skill', description: 'Sharpen a plan.' }
  },
  {
    dialect: CURSOR_ACP_DIALECT,
    command: { name: 'review', description: 'Review code. (project skill)' },
    row: { kind: 'skill', description: 'Review code.' }
  },
  {
    dialect: COPILOT_ACP_DIALECT,
    command: {
      name: 'review',
      description: 'Run code review agent to analyze changes',
      input: { hint: 'additional instructions' }
    },
    row: { kind: 'command', description: 'Run code review agent to analyze changes' }
  },
  {
    dialect: COPILOT_ACP_DIALECT,
    command: {
      name: 'grill-me',
      description: 'Sharpen a plan.',
      input: { hint: 'instructions for the skill' }
    },
    row: { kind: 'skill', description: 'Sharpen a plan.' }
  },
  {
    dialect: KIMI_ACP_DIALECT,
    command: { name: 'compact', description: 'Compact the conversation context' },
    row: { kind: 'command', description: 'Compact the conversation context' }
  },
  {
    dialect: KIMI_ACP_DIALECT,
    command: { name: 'skill:grill-me', description: 'Sharpen a plan.' },
    row: { kind: 'skill', description: 'Sharpen a plan.' }
  }
])('reads $command.name as a $row.kind', ({ dialect, command, row }) => {
  expect(acpSessionSlashCommand(command, dialect, false)).toMatchObject({
    name: command.name,
    ...row
  })
})
