import { describe, expect, it } from 'vitest'
import type { TerminalQuickCommand } from '../../../src/shared/terminal-quick-command-types'
import {
  buildMobileQuickCommandLaunch,
  formatQuickCommandFailure,
  getQuickCommandDisplayPreview,
  getQuickCommandPreview,
  supportsMobileQuickCommands
} from './quick-commands'

function command(overrides: Partial<TerminalQuickCommand> = {}): TerminalQuickCommand {
  return {
    id: 'command',
    label: 'Command',
    action: 'terminal-command',
    command: 'pnpm test',
    appendEnter: true,
    scope: { type: 'global' },
    ...overrides
  } as TerminalQuickCommand
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
    expect(
      buildMobileQuickCommandLaunch(
        command({
          action: 'agent-prompt',
          agent: 'codex',
          prompt: 'Review this diff'
        })
      )
    ).toEqual({ agent: 'codex', options: { agentPrompt: 'Review this diff' } })
  })

  it('bounds native row text without truncating searchable or executable content', () => {
    const longPrompt = `Review ${'x'.repeat(5993)}`
    const agentCommand = command({
      action: 'agent-prompt',
      agent: 'codex',
      prompt: longPrompt
    })

    expect(getQuickCommandDisplayPreview(agentCommand)).toHaveLength(240)
    expect(getQuickCommandDisplayPreview(agentCommand)).toMatch(/^Codex: Review .*…$/)
    expect(getQuickCommandPreview(agentCommand)).toBe(`Codex: ${longPrompt}`)
    expect(buildMobileQuickCommandLaunch(agentCommand)).toEqual({
      agent: 'codex',
      options: { agentPrompt: longPrompt }
    })
  })

  it('surfaces the underlying failure reason in the launch error message', () => {
    expect(formatQuickCommandFailure("Couldn't run codex review", 'after_tab_not_found')).toBe(
      "Couldn't run codex review — after_tab_not_found"
    )
    expect(
      formatQuickCommandFailure(
        "Couldn't run codex review",
        new Error('relay RPC timed out: session.tabs.createTerminal')
      )
    ).toBe("Couldn't run codex review — relay RPC timed out: session.tabs.createTerminal")
    // No detail (or a detail equal to the label) keeps the plain label.
    expect(formatQuickCommandFailure("Couldn't run codex review", undefined)).toBe(
      "Couldn't run codex review"
    )
    expect(formatQuickCommandFailure("Couldn't run x", "Couldn't run x")).toBe("Couldn't run x")
    expect(formatQuickCommandFailure(undefined, '  ')).toBe('Failed to create terminal')
    expect(formatQuickCommandFailure(undefined, 'boom')).toBe('Failed to create terminal — boom')
  })
})
