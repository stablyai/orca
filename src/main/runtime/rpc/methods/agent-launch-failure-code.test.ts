import { describe, expect, it } from 'vitest'
import { launchFailureWithoutEffectsCode } from './agent-launch-failure-code'
import { trackTerminalSpawnDispatch } from '../../../agent-launch/agent-launch-not-started'
import { describeLaunchFileUnavailable } from '../../../../shared/launch-prompt-file'

describe('a launch that failed without effects', () => {
  // Why: every host refuses a launch file before it spawns anything, so the phone's replay must
  // get the reason, not "outcome unknown", even after the spawn request left this process.
  it('includes a launch-file refusal for an existing workspace, as it arrives from any host', () => {
    const dispatched = trackTerminalSpawnDispatch()
    dispatched.onPtySpawnDispatched()
    const refusal = new Error(describeLaunchFileUnavailable("the WSL distro's home is gone"))
    expect(launchFailureWithoutEffectsCode(refusal, 'existing', dispatched)).toBe(
      'launch_file_unavailable'
    )
  })

  it('leaves it out for a created workspace, which exists whatever the agent did', () => {
    const refusal = new Error(describeLaunchFileUnavailable('disk full'))
    expect(
      launchFailureWithoutEffectsCode(refusal, 'create-worktree', trackTerminalSpawnDispatch())
    ).toBeNull()
  })

  it('leaves out any other failure after the spawn request left', () => {
    const dispatched = trackTerminalSpawnDispatch()
    dispatched.onPtySpawnDispatched()
    expect(
      launchFailureWithoutEffectsCode(new Error('spawn ENOENT'), 'existing', dispatched)
    ).toBeNull()
  })
})
