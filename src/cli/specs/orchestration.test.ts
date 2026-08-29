import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_COMMAND_SPECS } from './orchestration'

describe('orchestration command specs', () => {
  it('describes run-use as a fenced authority claim for agents', () => {
    const runUse = ORCHESTRATION_COMMAND_SPECS.find(
      (spec) => spec.path.join(' ') === 'orchestration run-use'
    )
    const guidance = [runUse?.summary, ...(runUse?.notes ?? [])].join('\n')

    expect(guidance).toContain('coordinator authority')
    expect(guidance).toContain('owning host proves the prior coordinator exited')
    expect(guidance).toContain('live')
    expect(guidance).toContain('unverifiable')
    expect(guidance).toContain('consumer_fenced')
    expect(guidance).toContain('Do not retry blindly')
    expect(guidance).toContain('--takeover-legacy')
    expect(guidance).toContain('not a force override for ordinary Runs')
  })
})
