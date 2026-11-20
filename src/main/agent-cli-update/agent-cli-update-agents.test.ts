import { describe, expect, it } from 'vitest'
import { agentCliUpdateDefinition } from './agent-cli-update-agents'

describe('agentCliUpdateDefinition', () => {
  it("reads Cursor's dated build without its hash", () => {
    expect(agentCliUpdateDefinition('cursor').parseVersion?.('2026.11.17-f532c45\n')).toBe(
      '2026.11.17'
    )
  })

  it('looks up the latest OpenCode on the installed major', () => {
    expect(agentCliUpdateDefinition('opencode').latest('1.19.5')).toEqual({
      kind: 'npm',
      package: 'opencode-ai'
    })
    expect(agentCliUpdateDefinition('opencode').latest('2.3.1')).toEqual({
      kind: 'npm',
      package: '@opencode/cli'
    })
  })
})
