import { describe, expect, it } from 'vitest'
import {
  agentStartupBlockedMessage,
  CLAUDE_BYPASS_WARNING_HINT
} from './agent-startup-blocked-message'

function runtimeShowing(tail: string[]) {
  return {
    readTerminal: async (handle: string) => ({
      handle,
      status: 'running' as const,
      tail,
      truncated: false,
      nextCursor: null
    })
  }
}

// Claude 2.1.316's warning, as Orca's startup-dialog matcher reads it.
const BYPASS_SCREEN = [
  '────────────────────────',
  ' WARNING: Claude Code running in Bypass Permissions mode',
  '',
  '  ❯ 1. No, exit',
  '    2. Yes, I accept',
  '',
  ' Enter to confirm · Esc to cancel'
]

describe('agentStartupBlockedMessage', () => {
  it('names the bypass warning and the setting that avoids it, keeping the parsed reason first', async () => {
    const message = await agentStartupBlockedMessage(
      runtimeShowing(BYPASS_SCREEN),
      'term_1',
      'agent-startup-menu-prompt'
    )
    expect(message).toBe(
      `Agent startup blocked: agent-startup-menu-prompt. ${CLAUDE_BYPASS_WARNING_HINT}`
    )
    expect(message).toContain("Each agent's own settings")
  })

  it('leaves other startup menus as the bare reason', async () => {
    const message = await agentStartupBlockedMessage(
      runtimeShowing([
        ' New MCP server found in .mcp.json: docs',
        ' Enter to confirm · Esc to cancel'
      ]),
      'term_1',
      'agent-startup-menu-prompt'
    )
    expect(message).toBe('Agent startup blocked: agent-startup-menu-prompt')
  })

  it('does not read the screen for other reasons and keeps the legacy alias', async () => {
    const runtime = {
      readTerminal: async () => {
        throw new Error('should not read')
      }
    }
    await expect(
      agentStartupBlockedMessage(runtime, 'term_1', 'codex-interactive-prompt')
    ).resolves.toBe('Agent startup blocked: codex-interactive-prompt (agent-interactive-prompt)')
  })

  it('falls back to the bare reason when the pane is gone', async () => {
    const runtime = {
      readTerminal: async () => {
        throw new Error('terminal_not_found')
      }
    }
    await expect(
      agentStartupBlockedMessage(runtime, 'term_1', 'agent-startup-menu-prompt')
    ).resolves.toBe('Agent startup blocked: agent-startup-menu-prompt')
  })
})
