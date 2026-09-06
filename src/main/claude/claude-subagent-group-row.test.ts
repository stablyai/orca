import { describe, expect, it } from 'vitest'
import type { NativeChatSubagentEntry } from '../../shared/native-chat-types'
import { claudeSubagentGroupBody } from './claude-subagent-group-row'

function entry(id: string, state: NativeChatSubagentEntry['state']): NativeChatSubagentEntry {
  return { id, label: id, state, startedAt: 1 }
}

/** The fallback sentence is the WHOLE row on mobile and paired web, which have
 *  no roster renderer, so these assertions are the entire contract there. */
function sentence(agents: readonly NativeChatSubagentEntry[]): string {
  const body = claudeSubagentGroupBody('turn-1', agents)
  const block = body.kind === 'message' ? body.blocks[0] : undefined
  return block && block.type === 'text' ? block.text : ''
}

describe('claudeSubagentGroupBody fallback sentence', () => {
  it('reads as a plain completion when every child completed', () => {
    expect(sentence([entry('a', 'completed'), entry('b', 'completed')])).toBe('Ran 2 subagents')
  })

  it('keeps the singular noun for a lone child', () => {
    expect(sentence([entry('a', 'completed')])).toBe('Ran 1 subagent')
    expect(sentence([entry('a', 'working')])).toBe('Kicked off 1 subagent — 1 working')
  })

  it('names an unverifiable child instead of claiming the group ran', () => {
    expect(sentence([entry('a', 'completed'), entry('b', 'unverifiable')])).toBe(
      'Ran 2 subagents (1 unverifiable)'
    )
  })

  it('ranks the adverse outcome worst-first', () => {
    expect(
      sentence([entry('a', 'failed'), entry('b', 'unverifiable'), entry('c', 'completed')])
    ).toBe('Ran 3 subagents (1 failed)')
    expect(sentence([entry('a', 'stopped'), entry('b', 'unverifiable')])).toBe(
      'Ran 2 subagents (1 stopped)'
    )
  })

  it('shows the adverse outcome while a sibling still works', () => {
    expect(
      sentence([entry('a', 'working'), entry('b', 'working'), entry('c', 'unverifiable')])
    ).toBe('Kicked off 3 subagents — 2 working (1 unverifiable)')
  })

  it('leaves a benign settled state out of the sentence', () => {
    expect(sentence([entry('a', 'idle'), entry('b', 'completed')])).toBe('Ran 2 subagents')
  })

  it('counts every child holding the worst adverse state', () => {
    expect(sentence([entry('a', 'failed'), entry('b', 'failed'), entry('c', 'stopped')])).toBe(
      'Ran 3 subagents (2 failed)'
    )
  })
})
