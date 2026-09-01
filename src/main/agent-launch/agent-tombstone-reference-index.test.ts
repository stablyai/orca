import { describe, expect, it } from 'vitest'
import {
  AgentTombstoneReferenceIndex,
  type AgentReferenceOwnerScanner
} from './agent-tombstone-reference-index'
import type { AgentReferenceOwnerKind } from '../../shared/agent-reference-snapshot'
import type { CustomTuiAgentId } from '../../shared/types'

const customA = 'custom-agent:claude:01234567-89ab-4cde-8f01-23456789abcd' as CustomTuiAgentId
const customB = 'custom-agent:claude:fedcba98-7654-4321-8fed-cba987654321' as CustomTuiAgentId
const customCodex = 'custom-agent:codex:11111111-2222-4333-8444-555566667777' as CustomTuiAgentId

function scannerOf(
  owner: AgentReferenceOwnerKind,
  ids: readonly unknown[]
): AgentReferenceOwnerScanner {
  return { owner, scan: () => ({ ok: true, referencedIds: ids }) }
}

function failingScanner(owner: AgentReferenceOwnerKind): AgentReferenceOwnerScanner {
  return { owner, scan: () => ({ ok: false }) }
}

describe('AgentTombstoneReferenceIndex — custom-id GC counting (invariant across the raw-id refactor)', () => {
  it('counts every occurrence of a custom id across owners', () => {
    const index = new AgentTombstoneReferenceIndex()
    index.register(scannerOf('default', [customA]))
    // A quick-command list can reference the same id twice; both count.
    index.register(scannerOf('quick-command', [customA, customA, null]))
    index.register(scannerOf('automation', [customB]))
    expect(index.countReferences(customA)).toBe(3)
    expect(index.countReferences(customB)).toBe(1)
  })

  it('returns unknown when any owner scan fails, so GC always retains conservatively', () => {
    const index = new AgentTombstoneReferenceIndex()
    index.register(scannerOf('default', [customA]))
    index.register(failingScanner('automation'))
    expect(index.countReferences(customA)).toBe('unknown')
  })

  it('summarizes per owner and reports -1 for an unreadable owner', () => {
    const index = new AgentTombstoneReferenceIndex()
    index.register(scannerOf('quick-command', [customA, customA]))
    index.register(failingScanner('automation'))
    index.register(scannerOf('default', [customB]))
    const summary = index.summarizeReferences(customA)
    expect(summary).toContainEqual({ owner: 'quick-command', count: 2 })
    expect(summary).toContainEqual({ owner: 'automation', count: -1 })
    // An owner with zero references for this id is omitted.
    expect(summary.some((entry) => entry.owner === 'default')).toBe(false)
  })
})

describe('AgentTombstoneReferenceIndex.countMatchingReferences — base-disable impact (§973)', () => {
  // Disabling base 'claude' blocks the base id itself and its derivatives.
  const matchesClaudeAndDerivatives = (value: unknown): boolean =>
    value === 'claude' || value === customA || value === customB

  it('counts the base id and its derivatives across owners', () => {
    const index = new AgentTombstoneReferenceIndex()
    index.register(scannerOf('default', ['claude']))
    index.register(scannerOf('quick-command', [customA, customCodex, 'codex']))
    index.register(scannerOf('automation', [customB]))
    const result = index.countMatchingReferences(matchesClaudeAndDerivatives)
    // 'claude' + customA + customB = 3; the unrelated codex references are ignored.
    expect(result).toEqual({ count: 3, complete: true })
  })

  it('excludes owners counted separately (sessions) without affecting completeness', () => {
    const index = new AgentTombstoneReferenceIndex()
    index.register(scannerOf('default', ['claude']))
    index.register(scannerOf('session', [customA, customB]))
    const result = index.countMatchingReferences(matchesClaudeAndDerivatives, {
      excludeOwners: new Set(['session'])
    })
    expect(result).toEqual({ count: 1, complete: true })
  })

  it('returns the readable partial with complete=false when a non-excluded owner is unreadable', () => {
    const index = new AgentTombstoneReferenceIndex()
    index.register(scannerOf('default', ['claude']))
    index.register(failingScanner('automation'))
    const result = index.countMatchingReferences(matchesClaudeAndDerivatives)
    expect(result).toEqual({ count: 1, complete: false })
  })

  it('an unreadable EXCLUDED owner does not taint completeness', () => {
    const index = new AgentTombstoneReferenceIndex()
    index.register(scannerOf('default', ['claude']))
    index.register(failingScanner('session'))
    const result = index.countMatchingReferences(matchesClaudeAndDerivatives, {
      excludeOwners: new Set(['session'])
    })
    expect(result).toEqual({ count: 1, complete: true })
  })
})
