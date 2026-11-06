import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { takeRealAgentCliCalls } from './vitest-real-agent-cli-guard'

afterEach(() => {
  takeRealAgentCliCalls()
})

describe.skipIf(process.platform === 'win32')('vitest real-agent-cli guard', () => {
  it('blocks and records an agent CLI resolved from the inherited PATH', () => {
    const result = spawnSync('claude', ['--version'], { encoding: 'utf8', env: process.env })
    expect(result.status).toBe(127)
    expect(result.stderr).toMatch(/real-agent-cli guard/)
    expect(takeRealAgentCliCalls()).toEqual(['claude --version'])
  })

  it('records calls from a shell that keeps the inherited PATH', () => {
    spawnSync('/bin/sh', ['-c', 'copilot --help; codex exec x'], { env: process.env })
    expect(takeRealAgentCliCalls()).toEqual(['copilot --help', 'codex exec x'])
  })
})
