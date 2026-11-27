import { describe, expect, it } from 'vitest'
import { VIBE_ACP_LAUNCH_SPEC } from './vibe-acp-launch-spec'

describe('VIBE_ACP_LAUNCH_SPEC', () => {
  it('maps every Orca permission mode to a vibe-acp mode', () => {
    expect(VIBE_ACP_LAUNCH_SPEC.permissionModeConfig?.values).toEqual({
      ask: 'ask',
      'accept-edits': 'accept-edits',
      auto: 'smart-approve',
      'full-access': 'auto-approve'
    })
  })

  it('only answers with advertised auth methods', () => {
    expect(VIBE_ACP_LAUNCH_SPEC.authMethod?.({ advertised: ['browser-auth'], env: {} })).toBe(
      'browser-auth'
    )
    expect(
      VIBE_ACP_LAUNCH_SPEC.authMethod?.({ advertised: ['browser-auth-delegated'], env: {} })
    ).toBeUndefined()
    // A set MISTRAL_API_KEY must not produce an id vibe-acp does not advertise.
    expect(
      VIBE_ACP_LAUNCH_SPEC.authMethod?.({
        advertised: ['browser-auth'],
        env: { MISTRAL_API_KEY: 'sk-test' }
      })
    ).toBe('browser-auth')
  })

  it('does not claim a launch-line model: vibe-acp rejects --model and drops sessionMeta kwargs', () => {
    expect(VIBE_ACP_LAUNCH_SPEC.launchesWithModel).toBeUndefined()
    expect(
      VIBE_ACP_LAUNCH_SPEC.args({ fullAccess: false, pluginDirs: [], model: 'mistral-large' })
    ).toEqual([])
  })

  it("searches uv's tool bin directory for vibe-acp", () => {
    expect(VIBE_ACP_LAUNCH_SPEC.installDirectories({ env: {}, homePath: '/home/u' })).toEqual([
      '/home/u/.local/bin',
      '/home/u/.vibe/bin'
    ])
  })
})
