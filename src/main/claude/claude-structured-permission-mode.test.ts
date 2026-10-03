import { describe, expect, it } from 'vitest'
import { claudeStructuredPermissionModeForSettings } from './claude-structured-permission-mode'

describe('claudeStructuredPermissionModeForSettings', () => {
  // The untouched case is the common one and the easiest to get wrong: a profile with no stored
  // mode gets the default Orca ships, which is bypass — what a terminal launch has always applied.
  it('bypasses when the user has never opened Agent settings', () => {
    expect(claudeStructuredPermissionModeForSettings({ agentDefaultArgs: {} })).toBe(
      'bypassPermissions'
    )
    expect(claudeStructuredPermissionModeForSettings({})).toBe('bypassPermissions')
    expect(claudeStructuredPermissionModeForSettings(null)).toBe('bypassPermissions')
    expect(claudeStructuredPermissionModeForSettings({ agentDefaultArgs: { codex: '' } })).toBe(
      'bypassPermissions'
    )
  })

  it('bypasses in Yolo with or without extra arguments', () => {
    expect(
      claudeStructuredPermissionModeForSettings({
        agentPermissionMode: 'bypass',
        agentDefaultArgs: { claude: '--model Opus' }
      })
    ).toBe('bypassPermissions')
  })

  // A terminal launch honours a bypass flag typed into Arguments, so the structured path does too.
  it('bypasses when the flag is typed into Arguments under Manual', () => {
    for (const claude of [
      '--dangerously-skip-permissions',
      '--dangerously-skip-permissions --model Opus',
      '--model Opus --dangerously-skip-permissions'
    ]) {
      expect(
        claudeStructuredPermissionModeForSettings({
          agentPermissionMode: 'ask',
          agentDefaultArgs: { claude }
        }),
        claude
      ).toBe('bypassPermissions')
    }
  })

  it('prompts in Manual, globally or for Claude alone', () => {
    expect(claudeStructuredPermissionModeForSettings({ agentPermissionMode: 'ask' })).toBe(
      'default'
    )
    expect(
      claudeStructuredPermissionModeForSettings({
        agentPermissionModeOverrides: { claude: 'ask' },
        agentDefaultArgs: { claude: '--model Opus' }
      })
    ).toBe('default')
  })

  it('follows a Claude-only Yolo choice under a Manual default', () => {
    expect(
      claudeStructuredPermissionModeForSettings({
        agentPermissionMode: 'ask',
        agentPermissionModeOverrides: { claude: 'bypass' }
      })
    ).toBe('bypassPermissions')
  })
})
