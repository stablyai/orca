import { describe, expect, it } from 'vitest'
import { filterClaudeSettings } from './local-claude-settings-read'

describe('filterClaudeSettings', () => {
  it('keeps only allowlisted keys: never env, hooks, statusLine or helper commands', () => {
    const { payload, dropped } = filterClaudeSettings({
      model: 'opus',
      outputStyle: 'Explanatory',
      includeCoAuthoredBy: false,
      cleanupPeriodDays: 30,
      env: { ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz' },
      hooks: { PreToolUse: [] },
      statusLine: { type: 'command', command: '~/.claude/status.sh' },
      apiKeyHelper: '/usr/local/bin/key',
      awsAuthRefresh: 'aws sso login',
      forceLoginMethod: 'claudeai',
      permissions: { allow: ['Bash(npm test:*)'], additionalDirectories: ['/Users/me/x'] }
    })
    expect(payload).toEqual({
      model: 'opus',
      outputStyle: 'Explanatory',
      includeCoAuthoredBy: false,
      cleanupPeriodDays: 30,
      permissions: { allow: ['Bash(npm test:*)'] }
    })
    expect(dropped).toBe(0)
  })

  it('drops rules that name paths on this computer or hold a key, and counts them', () => {
    const { payload, dropped } = filterClaudeSettings({
      permissions: {
        allow: [
          'Read(~/.zshrc)',
          'Edit(/Users/me/projects/**)',
          'Bash(curl -H "Authorization: Bearer ghp_0123456789abcdefghijABCDEFGHIJ0123456789")'
        ],
        deny: ['Read(C:\\Users\\me\\secrets\\**)', 'Read(./.env)']
      }
    })
    expect(payload).toEqual({ permissions: { allow: ['Read(~/.zshrc)'], deny: ['Read(./.env)'] } })
    expect(dropped).toBe(3)
  })

  it('drops a value of the wrong type rather than sending it', () => {
    const { payload } = filterClaudeSettings({ model: 42, permissions: { allow: 'Bash(ls)' } })
    expect(payload).toEqual({})
  })
})
