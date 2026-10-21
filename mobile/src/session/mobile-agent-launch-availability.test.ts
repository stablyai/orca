import { describe, expect, it } from 'vitest'
import { resolveMobileAgentLaunchAvailability } from './mobile-agent-launch-availability'

const LAUNCH = ['agent.launch.v2', 'agent.launch.replay.v1', 'agent.launch.replay-required.v1']

describe('resolveMobileAgentLaunchAvailability', () => {
  it('is available when the host advertises the replay-required launch', () => {
    expect(
      resolveMobileAgentLaunchAvailability({
        hostCapabilities: LAUNCH,
        statusPending: false,
        statusReadable: true
      })
    ).toBe('available')
  })

  it('asks for an update only when the host answered without the capability', () => {
    expect(
      resolveMobileAgentLaunchAvailability({
        hostCapabilities: ['agent.launch.v2'],
        statusPending: false,
        statusReadable: true
      })
    ).toBe('update-required')
  })

  it('does not blame the host version when its status could not be read', () => {
    expect(
      resolveMobileAgentLaunchAvailability({
        hostCapabilities: [],
        statusPending: false,
        statusReadable: false
      })
    ).toBe('unverified')
  })

  it('waits while the status is being read', () => {
    expect(
      resolveMobileAgentLaunchAvailability({
        hostCapabilities: [],
        statusPending: true,
        statusReadable: false
      })
    ).toBe('checking')
  })
})
