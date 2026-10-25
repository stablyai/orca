import { describe, expect, it } from 'vitest'
import type {
  TerminalCommandQuickCommand,
  TerminalAgentQuickCommand
} from '../../../src/shared/terminal-quick-command-types'
import {
  buildMobileQuickCommandLaunch,
  getQuickCommandDisplayPreview,
  getQuickCommandPreview,
  supportsMobileQuickCommands
} from './quick-commands'

function command(
  overrides: Partial<TerminalCommandQuickCommand> = {}
): TerminalCommandQuickCommand {
  return {
    id: 'command',
    label: 'Command',
    action: 'terminal-command',
    command: 'pnpm test',
    appendEnter: true,
    scope: { type: 'global' },
    ...overrides
  }
}

function agentCommand(prompt: string): TerminalAgentQuickCommand {
  return {
    id: 'agent-command',
    label: 'Command',
    action: 'agent-prompt',
    agent: 'codex',
    prompt,
    scope: { type: 'global' }
  }
}

describe('mobile quick-command launch', () => {
  it('only exposes quick commands when the host advertises the complete contract', () => {
    expect(supportsMobileQuickCommands(undefined)).toBe(false)
    expect(supportsMobileQuickCommands([])).toBe(false)
    expect(supportsMobileQuickCommands(['terminal.binary-stream.v1'])).toBe(false)
    expect(supportsMobileQuickCommands(['terminal.quick-commands.v1'])).toBe(true)
  })

  it('joins multiline runnable commands with "; " to match desktop', () => {
    // Parity with desktop flattenTerminalQuickCommand: the same saved command
    // must run identically on desktop and mobile.
    expect(
      buildMobileQuickCommandLaunch(command({ command: 'cd app\nnpm install\nnpm test' }))
    ).toEqual({
      options: {
        startupCommand: 'cd app; npm install; npm test',
        startupCommandDelivery: 'shell-ready'
      }
    })
  })

  it('forces shell-ready delivery for commands that resemble bare agent launches', () => {
    expect(buildMobileQuickCommandLaunch(command({ command: 'codex exec --full-auto' }))).toEqual({
      options: {
        startupCommand: 'codex exec --full-auto',
        startupCommandDelivery: 'shell-ready'
      }
    })
  })

  it('keeps append-enter-off commands as unsubmitted terminal input', () => {
    const multiline = 'printf "first\\nsecond"\n# leave this unsubmitted'
    expect(
      buildMobileQuickCommandLaunch(command({ command: multiline, appendEnter: false }))
    ).toEqual({
      options: { initialPrompt: multiline, enter: false, successToast: 'Command inserted' }
    })
  })

  it('injects supported agent prompts into the host-built launch command', () => {
    expect(buildMobileQuickCommandLaunch(agentCommand('Review this diff'))).toEqual({
      agent: 'codex',
      options: { agentPrompt: 'Review this diff' }
    })
  })

  it('bounds native row text without truncating searchable or executable content', () => {
    const longPrompt = `Review ${'x'.repeat(5993)}`
    const savedCommand = agentCommand(longPrompt)

    expect(getQuickCommandDisplayPreview(savedCommand)).toHaveLength(240)
    expect(getQuickCommandDisplayPreview(savedCommand)).toMatch(/^Codex: Review .*…$/)
    expect(getQuickCommandPreview(savedCommand)).toBe(`Codex: ${longPrompt}`)
    expect(buildMobileQuickCommandLaunch(savedCommand)).toEqual({
      agent: 'codex',
      options: { agentPrompt: longPrompt }
    })
  })
})
