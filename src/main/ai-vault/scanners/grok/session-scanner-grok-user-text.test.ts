import { describe, expect, it } from 'vitest'
import {
  extractGrokFirstUserPromptText,
  isGrokBootstrapContextText,
  stripGrokUserQueryEnvelope
} from './session-scanner-grok-user-text'

describe('Grok first-user prompt text', () => {
  it('unwraps user_query and drops the user_info bootstrap envelope', () => {
    const raw = [
      '<user_info>',
      'OS Version: macos',
      'Shell: /opt/homebrew/bin/bash',
      'Workspace Path: /Users/ada/repo',
      "Today's date: 2026-08-01",
      'Note: Prefer using relative paths',
      '</user_info>',
      '<user_query>',
      'fix i18n keep ko workspace worktree and primary',
      '</user_query>'
    ].join('\n')

    expect(extractGrokFirstUserPromptText(raw)).toBe(
      'fix i18n keep ko workspace worktree and primary'
    )
    expect(stripGrokUserQueryEnvelope(raw)).toBe('fix i18n keep ko workspace worktree and primary')
  })

  it('unwraps user_query even when the closing tag is missing', () => {
    const raw = '<user_info>context</user_info><user_query>\nShip the full first prompt copy path'
    expect(extractGrokFirstUserPromptText(raw)).toBe('Ship the full first prompt copy path')
  })

  it('rejects pure user_info bootstrap rows', () => {
    const bootstrap = [
      '<user_info>',
      'OS Version: macos',
      'Note: Prefer using relative paths over absolute paths',
      '</user_info>'
    ].join('\n')
    expect(isGrokBootstrapContextText(bootstrap)).toBe(true)
    expect(extractGrokFirstUserPromptText(bootstrap)).toBeNull()
  })

  it('keeps ordinary user prompts', () => {
    expect(extractGrokFirstUserPromptText('fix the flaky vault tests')).toBe(
      'fix the flaky vault tests'
    )
  })
})
