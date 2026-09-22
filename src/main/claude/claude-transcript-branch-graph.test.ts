// The graph's own contract, independent of which bytes a reader fed it.

import { describe, expect, it } from 'vitest'
import { createBranchProof } from './claude-transcript-branch-graph'

const row = (uuid: string, parentUuid: string | null): string =>
  JSON.stringify({ type: 'user', uuid, parentUuid, sessionId: 'provider' })

function build(lines: string[], previousLeafUuid: string | null) {
  const builder = createBranchProof({ providerSessionId: 'provider', previousLeafUuid })
  for (const [index, line] of lines.entries()) {
    builder.add(line, index, true)
  }
  return builder
}

describe('createBranchProof ancestry chain', () => {
  const MARKER = JSON.stringify({ type: 'last-prompt', sessionId: 'provider', leafUuid: 'leaf' })

  it('returns the leaf-first chain back to, but excluding, the anchor', () => {
    const builder = build(
      [row('anchor', null), row('mid', 'anchor'), row('leaf', 'mid'), MARKER],
      'anchor'
    )
    builder.finish()

    expect(builder.ancestryChain('leaf', 'anchor')).toEqual(['leaf', 'mid'])
  })

  it('returns empty when the leaf IS the anchor', () => {
    const builder = build(
      [row('anchor', null), row('mid', 'anchor'), row('leaf', 'mid'), MARKER],
      'anchor'
    )
    builder.finish()

    expect(builder.ancestryChain('leaf', 'leaf')).toEqual([])
  })

  it('throws rather than reporting empty when the walk never reaches the anchor', () => {
    // Empty is the window's "nothing followed the anchor". Answering that for a
    // walk that fell off the graph would report non-delivery for records that
    // were never looked at, which is the one verdict reconciliation acts on.
    const builder = build(
      [row('anchor', null), row('mid', 'anchor'), row('leaf', 'mid'), MARKER],
      'anchor'
    )
    builder.finish()

    expect(() => builder.ancestryChain('leaf', 'absent')).toThrow('does not reach anchor absent')
  })
})
