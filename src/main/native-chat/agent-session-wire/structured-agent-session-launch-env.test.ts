import { describe, expect, it } from 'vitest'
import { hostTestAttachParams } from './structured-agent-session-host-test-data'
import {
  pinnedAgentSessionLaunchArgs,
  pinnedAgentSessionLaunchEnv
} from './structured-agent-session-launch-env'

describe('pinnedAgentSessionLaunchEnv', () => {
  it('layers the pinned account home over the shell environment', async () => {
    await expect(
      pinnedAgentSessionLaunchEnv(
        async () => ({ EXAMPLE_GATEWAY_TOKEN: 'shell-exported', CODEX_HOME: '/shell/home' }),
        hostTestAttachParams(null)
      )
    ).resolves.toEqual({
      launchEnv: {
        EXAMPLE_GATEWAY_TOKEN: 'shell-exported',
        CODEX_HOME: '/home/dev/.codex'
      }
    })
  })

  it('copies the host-resolved provider arguments into reservation authority', async () => {
    await expect(
      pinnedAgentSessionLaunchArgs(async () => ['--profile', 'review'], hostTestAttachParams(null))
    ).resolves.toEqual({ launchArgs: ['--profile', 'review'] })
  })
})
