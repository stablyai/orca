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
          ClaudeCode: '1',
          Claude_Code_Bridge_Session_Id: 'inherited-bridge',
          Claude_Code_Host_Session_Id: 'inherited-host',
          Claude_Code_Session_Attended: '1',
          Claude_Code_Messaging_Socket: 'parent-socket',
          Claude_Code_Messaging_Token: 'parent-token',
          Claude_Code_Execpath: 'parent-claude',
          Claude_Code_Entrypoint: 'parent-client',
          Claude_Code_Desktop_App_Version: 'parent-desktop',
          Claude_Effort: 'parent-effort',
          Claude_Pid: '123',
          Claude_Agent_Sdk_Version: 'parent-sdk',
          CLAUDE_CODE_HTTP_PROXY: 'http://configured-proxy',
          SAFE_VALUE: 'preserved'
        }
      }
    )

    expect(env).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'configured-token',
      Claude_Code_Session_Id: 'configured-session',
      CLAUDE_CODE_HTTP_PROXY: 'http://configured-proxy',
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
      Path: 'C:\\inherited',
      ...configured
    })
  })
})
