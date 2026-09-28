import { describe, expect, it } from 'vitest'
import { isAiVaultScopeFullyScanned } from './session-scope-coverage'
import type { SessionFileDiscovery } from './session-scanner-types'

function discovery(agent: SessionFileDiscovery['agent'], fileCount: number): SessionFileDiscovery {
  return {
    agent,
    rootDir: `/home/ada/.${agent}`,
    files: Array.from({ length: fileCount }, (_unused, index) => ({
      path: `/home/ada/.${agent}/${index}.jsonl`,
      mtimeMs: index,
      modifiedAt: new Date(index).toISOString(),
      sizeBytes: 1
    }))
  }
}

const scopePaths = ['/repos/orca']

describe('isAiVaultScopeFullyScanned', () => {
  it('vouches for a host whose agents all bucket transcripts by cwd', () => {
    expect(
      isAiVaultScopeFullyScanned({
        scopePaths,
        discoveries: [discovery('claude', 40), discovery('pi', 3)],
        scopePassBounded: false
      })
    ).toBe(true)
  })

  // Why: for Codex the scoped tab is a filter over the globally capped list, so
  // a deeper scan really does surface in-scope rows the cap hid (#22480).
  it('refuses to vouch once one agent without a cwd-bucket layout has transcripts', () => {
    expect(
      isAiVaultScopeFullyScanned({
        scopePaths,
        discoveries: [discovery('claude', 40), discovery('codex', 1)],
        scopePassBounded: false
      })
    ).toBe(false)
  })

  it('ignores an agent directory that holds nothing', () => {
    expect(
      isAiVaultScopeFullyScanned({
        scopePaths,
        discoveries: [discovery('claude', 40), discovery('codex', 0)],
        scopePassBounded: false
      })
    ).toBe(true)
  })

  it('refuses to vouch when the scoped pass itself hit its bound', () => {
    expect(
      isAiVaultScopeFullyScanned({
        scopePaths,
        discoveries: [discovery('claude', 40)],
        scopePassBounded: true
      })
    ).toBe(false)
  })

  it('claims nothing when the request carried no scope', () => {
    expect(
      isAiVaultScopeFullyScanned({
        scopePaths: [],
        discoveries: [discovery('claude', 40)],
        scopePassBounded: false
      })
    ).toBe(false)
  })
})
