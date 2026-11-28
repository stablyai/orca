import { describe, expect, it } from 'vitest'
import { SessionMcpTools } from '../../../mcp-servers/session-mcp-tools'
import type { ReadOnlySessionMode } from '../../../bots/bot-look-around-policy'
import { claudeBotSessionOptions } from './claude-bot-session-options'

function options(basis: { readOnly?: ReadOnlySessionMode; autoCompactPercent?: number }) {
  return claudeBotSessionOptions(
    { instructions: async () => null, ...basis },
    [],
    SessionMcpTools.none,
    { mcpConfig: false }
  )
}

describe('claudeBotSessionOptions auto compact', () => {
  it('passes the threshold in flag settings, where settings files cannot override it', async () => {
    expect((await options({ autoCompactPercent: 40 })).settings).toEqual({
      env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '40' }
    })
  })

  it('keeps a reply-only run’s hooks off when it adds the threshold', async () => {
    expect((await options({ readOnly: 'reply-only', autoCompactPercent: 55 })).settings).toEqual({
      disableAllHooks: true,
      env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '55' }
    })
  })

  it('adds no settings when the bot keeps Claude Code’s own threshold', async () => {
    expect((await options({})).settings).toBeUndefined()
  })
})
