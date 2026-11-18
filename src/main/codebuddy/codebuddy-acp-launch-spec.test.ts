import { describe, expect, it, vi } from 'vitest'
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

  it('does not treat --session-id as a resume', () => {
    expect(
      CODEBUDDY_LAUNCH_SPEC.sessionHistory.parseResumeArgs([
        'codebuddy',
        '--session-id',
        '01a1ee3f-e366-72bc-8d11-ceced281cf32'
      ])
    ).toBeNull()
  })

  it('finds the Windows installer directory under a redirected LOCALAPPDATA', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      expect(
        CODEBUDDY_LAUNCH_SPEC.installDirectories({
          env: { LOCALAPPDATA: 'D:\\Profiles\\me\\Local' },
          homePath: 'C:\\Users\\me'
        })
      ).toEqual(['D:\\Profiles\\me\\Local\\codebuddy\\bin'])
    } finally {
      platform.mockRestore()
    }
  })

  it('falls back to USERPROFILE when LOCALAPPDATA is empty', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      expect(
        CODEBUDDY_LAUNCH_SPEC.installDirectories({
          env: { LOCALAPPDATA: '', USERPROFILE: 'D:\\Users\\me' },
          homePath: 'C:\\Users\\me'
        })
      ).toEqual(['D:\\Users\\me\\AppData\\Local\\codebuddy\\bin'])
    } finally {
      platform.mockRestore()
    }
  })

  it('falls back to homePath when both Windows variables are absent', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      expect(
        CODEBUDDY_LAUNCH_SPEC.installDirectories({
          env: {},
          homePath: 'C:\\Users\\me'
        })
      ).toEqual(['C:\\Users\\me\\AppData\\Local\\codebuddy\\bin'])
    } finally {
      platform.mockRestore()
    }
  })
})
