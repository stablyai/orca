import { describe, expect, it } from 'vitest'
import { claudeStructuredPermissionModeForSettings } from './claude-structured-permission-mode'

describe('claudeStructuredPermissionModeForSettings', () => {
  // The three states the Agent Permissions toggle can leave behind. The untouched case is the
  // common one and the easiest to get wrong: the toggle writes nothing until it is used, and the
  // default Orca ships for the key it did not write is the bypass flag — which is what a terminal
  // launch has always applied to an untouched profile.
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

  it('bypasses when Yolo wrote the flag, alone or beside other tokens', () => {
    for (const claude of [
      '--dangerously-skip-permissions',
      '--dangerously-skip-permissions --model Opus',
      '--model Opus --dangerously-skip-permissions'
    ]) {
      expect(
        claudeStructuredPermissionModeForSettings({ agentDefaultArgs: { claude } }),
        claude
      ).toBe('bypassPermissions')
    }
  })

  // Manual is stored as an empty string, which owns the key and so beats the shipped default.
  it('prompts when Manual cleared the flag', () => {
    expect(claudeStructuredPermissionModeForSettings({ agentDefaultArgs: { claude: '' } })).toBe(
      'default'
    )
  })

  it('prompts when the user replaced the flag with something else', () => {
    expect(
      claudeStructuredPermissionModeForSettings({ agentDefaultArgs: { claude: '--model Opus' } })
    ).toBe('default')
  })
})
