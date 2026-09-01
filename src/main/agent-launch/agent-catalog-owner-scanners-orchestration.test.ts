import { describe, expect, it } from 'vitest'
import { AgentTombstoneReferenceIndex } from './agent-tombstone-reference-index'
import { registerOrchestrationOwnerScanner } from './agent-catalog-owner-scanners'
import type { CustomTuiAgentId } from '../../shared/types'

const deadId = 'custom-agent:codex:fedcba98-7654-4321-8fed-cba987654321' as CustomTuiAgentId

describe('orchestration owner scanner', () => {
  it('retains a tombstone while a dispatch references the id and prunes after it clears', () => {
    const index = new AgentTombstoneReferenceIndex()
    let referenced: string[] = [deadId]
    registerOrchestrationOwnerScanner(index, () => referenced)

    expect(index.countReferences(deadId)).toBe(1)
    expect(index.summarizeReferences(deadId)).toContainEqual({ owner: 'orchestration', count: 1 })

    referenced = []
    expect(index.countReferences(deadId)).toBe(0)
  })

  it('retains conservatively (unknown) when the dispatch store cannot be read', () => {
    const index = new AgentTombstoneReferenceIndex()
    registerOrchestrationOwnerScanner(index, () => {
      throw new Error('orchestration db unavailable')
    })
    expect(index.countReferences(deadId)).toBe('unknown')
  })

  it('is idempotent so a shared index never double-counts a dispatch reference', () => {
    const index = new AgentTombstoneReferenceIndex()
    const accessor = (): string[] => [deadId]
    registerOrchestrationOwnerScanner(index, accessor)
    registerOrchestrationOwnerScanner(index, accessor)
    expect(index.countReferences(deadId)).toBe(1)
  })
})
