import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const RUNTIME_SOURCE = readFileSync(join(__dirname, 'orca-runtime.ts'), 'utf8')

describe('OrcaRuntimeService Grok launch env wiring', () => {
  it('passes host and launch context to every main-side launch env resolution', () => {
    const calls = RUNTIME_SOURCE.match(/resolveTuiAgentLaunchEnv\([^)]*\)/g) ?? []

    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call).toContain('settings')
      expect(call).toContain('isRemote')
      expect(call).toContain('launchPlatform')
      expect(call).toContain('hostPlatform')
    }
  })
})
