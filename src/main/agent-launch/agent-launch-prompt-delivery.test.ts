import { describe, expect, it } from 'vitest'
import type { AgentLaunchIntent } from '../../shared/agent-launch-intent'
import { buildAutomationRunPreamble } from '../../shared/automation-run-preamble'
import { launchCommandPrompt, launchPromptCreateInputs } from './agent-launch-prompt-delivery'

const preamble = buildAutomationRunPreamble('orca')
const task = '  Write the brief'
const intent: AgentLaunchIntent = {
  agent: 'claude',
  target: { kind: 'existing', worktree: 'wt-1' },
  prompt: { text: task, automationInstructions: preamble.trimEnd(), delivery: 'submit' }
}

describe('automation launch prompt delivery', () => {
  it('journals instructions as a tagged block before the task', () => {
    expect(launchPromptCreateInputs(intent).firstMessage?.body).toEqual({
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: preamble.trimEnd(), presentation: 'automation-instructions' },
        { type: 'text', text: task }
      ]
    })
  })

  it('preserves the combined prompt when a chat falls back to a terminal', () => {
    expect(launchCommandPrompt(intent, 'terminal')).toBe(`${preamble}${task}`)
  })
})
