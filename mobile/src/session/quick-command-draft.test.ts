import { describe, expect, it } from 'vitest'
import {
  LEGACY_MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH,
  MAX_QUICK_COMMAND_AGENT_PROMPT_MESSAGE_BYTES
} from '../../../src/shared/terminal-quick-command-prompt-limit'
import { terminalQuickCommandAgentPromptMaxLength } from '../terminal/quick-commands'
import { TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY } from '../../../src/shared/terminal-quick-command-capabilities'
import {
  createEmptyQuickCommandDraft,
  draftToQuickCommand,
  isQuickCommandDraftPromptTooLong,
  type QuickCommandDraft
} from './quick-command-draft'

function agentDraft(prompt: string): QuickCommandDraft {
  return {
    ...createEmptyQuickCommandDraft({ type: 'global' }),
    label: 'Review',
    action: 'agent-prompt',
    agent: 'claude',
    prompt
  }
}

describe('quick command drafts', () => {
  it('saves a long prompt whole on a host that stores long prompts', () => {
    const prompt = 'x'.repeat(100_000)

    expect(draftToQuickCommand(agentDraft(prompt))).toMatchObject({ prompt })
    // Past what a chat message carries, measured on the prompt's real size.
    expect(
      draftToQuickCommand(agentDraft('x'.repeat(MAX_QUICK_COMMAND_AGENT_PROMPT_MESSAGE_BYTES)))
    ).toBeNull()
  })

  it('reads the host cap from its capabilities', () => {
    expect(terminalQuickCommandAgentPromptMaxLength(['terminal.quick-commands.v1'])).toBe(
      LEGACY_MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH
    )
    expect(
      terminalQuickCommandAgentPromptMaxLength([
        TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY
      ])
    ).toBeNull()
    // Unknown capabilities must not block a save; an older host refuses visibly itself.
    expect(terminalQuickCommandAgentPromptMaxLength(undefined)).toBeNull()
  })

  it('refuses rather than trims a prompt over an older host cap', () => {
    const draft = agentDraft('x'.repeat(LEGACY_MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH + 1))

    expect(
      isQuickCommandDraftPromptTooLong(draft, LEGACY_MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH)
    ).toBe(true)
    expect(draftToQuickCommand(draft, LEGACY_MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH)).toBeNull()
  })
})
