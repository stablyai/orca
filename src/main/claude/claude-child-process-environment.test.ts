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

  it('lets a launch value replace a differently cased inherited one on Windows only', () => {
    const inheritedEnv = { CLAUDE_CODE_ENTRYPOINT: 'cli', Path: 'C:\\inherited' }
    const configured = { claude_code_entrypoint: 'company-client', PATH: 'C:\\launch' }
    expect(buildClaudeChildProcessEnv(configured, { platform: 'win32', inheritedEnv })).toEqual({
      claude_code_entrypoint: 'company-client',
      PATH: 'C:\\launch'
    })
    expect(buildClaudeChildProcessEnv(configured, { platform: 'linux', inheritedEnv })).toEqual({
      ...inheritedEnv,
      ...configured
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
