import { describe, expect, it } from 'vitest'
import { MISSION_COMMAND_SPECS } from './mission'

describe('mission command specs', () => {
  it('exposes the orca-sub mission start surface without a shared retry request id', () => {
    const spec = MISSION_COMMAND_SPECS.find(
      (candidate) => candidate.path.join(' ') === 'mission start'
    )
    expect(spec).toBeDefined()
    expect(spec?.usage).toContain('mission start --text <mission>')
    expect(spec?.allowedFlags).toEqual(
      expect.arrayContaining(['text', 'agent', 'worktree', 'from', 'json'])
    )
    expect(spec?.allowedFlags).not.toContain('retry-request')
  })
})
