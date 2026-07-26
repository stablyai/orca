import { describe, expect, it } from 'vitest'
import { supportsBrowserPageFlag } from './args'
import { formatCommandHelp } from './help'
import { AGENT_MEMORY_COMMAND_SPECS } from './specs/agent-memory'

describe('agent memory help', () => {
  it('describes memory-specific flags without browser options', () => {
    const remember = AGENT_MEMORY_COMMAND_SPECS.find(
      (spec) => spec.path.join(' ') === 'agent memory remember'
    )
    expect(remember).toBeDefined()

    const help = formatCommandHelp(remember!)

    expect(help).toContain('--title <text>         Concise memory title')
    expect(help).toContain('--source <ref>         Evidence reference')
    expect(help).not.toContain('--page <id>')
    expect(supportsBrowserPageFlag(['agent', 'memory', 'remember'])).toBe(false)
  })
})
