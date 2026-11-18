import { describe, expect, it } from 'vitest'
import { acpLaunchSpecFor } from '../acp/launch/acp-launch-registry'
import { CODEBUDDY_LAUNCH_SPEC } from './codebuddy-acp-launch-spec'

describe('CodeBuddy ACP launch spec', () => {
  it('is the registered chat spec', () => {
    expect(acpLaunchSpecFor('codebuddy')).toBe(CODEBUDDY_LAUNCH_SPEC)
  })

  it('starts the CLI in ACP mode', () => {
    expect(CODEBUDDY_LAUNCH_SPEC.args({ fullAccess: false, pluginDirs: [] })).toEqual(['--acp'])
  })

  it('pins the CLI config directory', () => {
    expect(CODEBUDDY_LAUNCH_SPEC.account.pin).toEqual({
      accountHomeVariable: 'CODEBUDDY_CONFIG_DIR'
    })
  })

  it("maps the chat modes onto CodeBuddy's own modes", () => {
    expect(CODEBUDDY_LAUNCH_SPEC.permissionModeConfig?.values).toEqual({
      ask: 'default',
      'accept-edits': 'acceptEdits',
      auto: 'auto',
      'full-access': 'fullAccess'
    })
  })

  it('resumes a session by id or continues the latest one', () => {
    expect(
      CODEBUDDY_LAUNCH_SPEC.sessionHistory.parseResumeArgs([
        'codebuddy',
        '--resume',
        '01a1ee3f-e366-72bc-8d11-ceced281cf32'
      ])
    ).toEqual({ target: '01a1ee3f-e366-72bc-8d11-ceced281cf32' })
    expect(
      CODEBUDDY_LAUNCH_SPEC.sessionHistory.parseResumeArgs(['codebuddy', '--continue'])
    ).toEqual({ target: null })
  })
})
