import { describe, expect, it } from 'vitest'
import { AGENT_LAUNCH_DISABLED_CODE } from '../../../../shared/agent-launch-disabled'
import { launchFailureWithoutEffectsCode } from './agent-launch-failure-code'
import type { TerminalSpawnDispatch } from '../../../agent-launch/agent-launch-not-started'

// Nothing was dispatched: a launch refused before spawn never reached the terminal.
const noSpawn: TerminalSpawnDispatch = {
  onPtySpawnDispatched: () => {},
  rethrow: (error) => {
    throw error
  },
  failedBeforeDispatch: () => false
}

describe('launchFailureWithoutEffectsCode', () => {
  it('treats a disabled agent as a definite refusal, not an unknown outcome', () => {
    const refusal = Object.assign(new Error('Agent opencode is disabled.'), {
      code: AGENT_LAUNCH_DISABLED_CODE
    })
    expect(launchFailureWithoutEffectsCode(refusal, 'existing', noSpawn)).toBe(
      AGENT_LAUNCH_DISABLED_CODE
    )
  })

  it('leaves an uncoded error unknown', () => {
    expect(launchFailureWithoutEffectsCode(new Error('boom'), 'existing', noSpawn)).toBeNull()
  })
})
