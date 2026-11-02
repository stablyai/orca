import { describe, expect, it } from 'vitest'
import { applyClaudeEnvPatch } from '../claude-accounts/environment'
import { buildClaudeChildProcessEnv } from './claude-child-process-environment'

describe('Claude child process environment', () => {
  it('strips case-insensitive auth headers through the shared env patch on Windows', () => {
    expect(
      applyClaudeEnvPatch(
        {
          anthropic_api_key: 'inherited-key',
          Anthropic_Custom_Headers: 'Authorization: inherited',
          SAFE_VALUE: 'preserved'
        },
        {},
        { stripAuthEnv: true, platform: 'win32' }
      )
    ).toEqual({ SAFE_VALUE: 'preserved' })
  })

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

  it('can strip child-session stamps reintroduced by a full SDK launch overlay', () => {
    expect(
      buildClaudeChildProcessEnv(
        {
          CLAUDE_CODE_CHILD_SESSION: 'configured-child-session',
          CLAUDE_CODE_SESSION_ID: 'configured-session',
          CLAUDE_CODE_BRIDGE_SESSION_ID: 'configured-bridge-session'
        },
        {
          scrubConfiguredChildSessionStamps: true,
          inheritedEnv: {
            CLAUDE_CODE_CHILD_SESSION: 'inherited-child-session',
            SAFE_VALUE: 'preserved'
          }
        }
      )
    ).toEqual({ SAFE_VALUE: 'preserved' })
  })
})
