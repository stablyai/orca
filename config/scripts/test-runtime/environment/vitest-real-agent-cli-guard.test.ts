import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { takeRealAgentCliCalls } from './vitest-real-agent-cli-guard'

afterEach(() => {
  takeRealAgentCliCalls()
})

describe.skipIf(!globalThis.orcaRealAgentCliGuard)('vitest real-agent-cli guard', () => {
  it('blocks and records an agent CLI resolved from the inherited PATH', () => {
    const result = spawnSync('claude', ['-p', 'hello'], { encoding: 'utf8', env: process.env })
    expect(result.status).toBe(127)
    expect(result.stderr).toMatch(/real-agent-cli guard/)
    expect(takeRealAgentCliCalls()).toEqual(['claude -p hello'])
  })
})
