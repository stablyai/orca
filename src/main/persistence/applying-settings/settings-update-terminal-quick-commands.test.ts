import { describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { TerminalQuickCommand } from '../../../shared/terminal/quick-commands/terminal-quick-command-types'
import {
  getTerminalQuickCommandPromptMessageBytes,
  MAX_QUICK_COMMAND_AGENT_PROMPT_MESSAGE_BYTES
} from '../../../shared/terminal/quick-commands/terminal-quick-command-prompt-limit'
import { updateSettings, type SettingsMutationOperations } from './settings-update'

function makeOperations(): SettingsMutationOperations {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields updateSettings reads for this setting.
    state: { settings: { terminalQuickCommands: [] }, repos: [] } as unknown as PersistedState,
    bumpLocalWorktreeScanGeneration: vi.fn(),
    removeRetainedBlob: vi.fn(),
    scheduleSave: vi.fn(),
    notifySettingsChanged: vi.fn()
  }
}

function promptAtLimit(character: string): string {
  const overhead = getTerminalQuickCommandPromptMessageBytes('')
  const perCharacter = getTerminalQuickCommandPromptMessageBytes(character) - overhead
  return character.repeat(
    Math.floor((MAX_QUICK_COMMAND_AGENT_PROMPT_MESSAGE_BYTES - overhead) / perCharacter)
  )
}

function agentCommand(id: string, prompt: string): TerminalQuickCommand {
  return {
    id,
    label: id,
    action: 'agent-prompt',
    agent: 'claude',
    prompt,
    scope: { type: 'global' }
  }
}

// Local and paired saves enforce prompt bounds at this shared store entrypoint.
describe('updateSettings terminalQuickCommands', () => {
  it('refuses a prompt over the limit rather than trimming it', () => {
    const operations = makeOperations()

    expect(() =>
      updateSettings(operations, {
        opencodeSessionCookie: '',
        httpProxyUrl: '',
        terminalQuickCommands: [agentCommand('review', `${promptAtLimit('x')}x`)]
      })
    ).toThrow(/"review" is 257 KB\. Quick command prompts can be up to 256 KB/)
    expect(operations.removeRetainedBlob).not.toHaveBeenCalled()
    expect(operations.scheduleSave).not.toHaveBeenCalled()
  })
})
