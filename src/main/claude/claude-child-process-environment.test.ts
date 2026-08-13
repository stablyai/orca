import { describe, expect, it } from 'vitest'
import { buildClaudeChildProcessEnv } from './claude-child-process-environment'

describe('Claude child process environment', () => {
  it('strips case-insensitive inherited auth and session stamps on Windows', () => {
    const env = buildClaudeChildProcessEnv(
      {
        ANTHROPIC_AUTH_TOKEN: 'configured-token',
        Claude_Code_Session_Id: 'configured-session'
      },
      {
        platform: 'win32',
        inheritedEnv: {
          anthropic_api_key: 'inherited-key',
          Anthropic_Custom_Headers: 'Authorization: inherited',
          claude_code_child_session: '1',
          CLAUDE_CODE_SESSION_ID: 'inherited-session',
          SAFE_VALUE: 'preserved'
        }
      }
    )

    expect(env).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'configured-token',
      Claude_Code_Session_Id: 'configured-session',
      SAFE_VALUE: 'preserved'
    })
  })
})
