import { describe, expect, it } from 'vitest'
import { GEMINI_LAUNCH_SPEC } from './gemini-acp-launch-spec'

// Shapes printed by Gemini CLI 0.68.0.
describe('GEMINI_LAUNCH_SPEC', () => {
  it('closes signed out on the manual sign-in URL, not on the line before it', () => {
    const url =
      'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fcodeassist.google.com%2Fauthcode' +
      '&access_type=offline&scope=openid&code_challenge_method=S256&code_challenge=abc&state=def' +
      '&response_type=code&client_id=id.apps.googleusercontent.com'
    const read = (line: string) => GEMINI_LAUNCH_SPEC.signIn?.read(line, 'stdout')
    expect(read('Please visit the following URL to authorize the application:')).toBeUndefined()
    expect(read(url)).toBe(url)
  })

  it('reads `latest` and list indexes as no particular session', () => {
    const parse = GEMINI_LAUNCH_SPEC.sessionHistory.parseResumeArgs
    expect(parse(['--resume', 'latest'])).toEqual({ target: null })
    expect(parse(['-r', '3'])).toEqual({ target: null })
    expect(parse(['--resume', '0d4f2c1e-8a2b-4c39-9d7e-3f1a5b6c7d8e'])).toEqual({
      target: '0d4f2c1e-8a2b-4c39-9d7e-3f1a5b6c7d8e'
    })
  })
})
