import { expect, it } from 'vitest'
import {
  AGENT_PROMPT_CTRL_ENTER_SUBMIT,
  AGENT_PROMPT_SUBMIT,
  resolveAgentPromptSubmitInput
} from '../../../../shared/agent-launch/startup/agent-prompt-injection'

it.each([
  // #51649: OpenCode loses a remapped `input.submit` a bare CR no longer triggers.
  { agent: 'opencode', expected: AGENT_PROMPT_CTRL_ENTER_SUBMIT },
  { agent: 'claude', expected: AGENT_PROMPT_SUBMIT },
  { agent: 'codex', expected: AGENT_PROMPT_SUBMIT },
  { agent: null, expected: AGENT_PROMPT_SUBMIT },
  { agent: 'not-an-agent', expected: AGENT_PROMPT_SUBMIT }
])('a $agent prompt submits with $expected', ({ agent, expected }) => {
  expect(resolveAgentPromptSubmitInput(agent as never)).toBe(expected)
})

it('Ctrl+Enter is the CSI-u sequence OpenCode decodes, not a CR', () => {
  expect(AGENT_PROMPT_CTRL_ENTER_SUBMIT).toBe('\x1b[13;5u')
  expect(AGENT_PROMPT_CTRL_ENTER_SUBMIT).not.toBe(AGENT_PROMPT_SUBMIT)
})
