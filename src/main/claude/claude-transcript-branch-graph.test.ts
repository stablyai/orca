// The graph's own contract, independent of which bytes a reader fed it.

import { describe, expect, it } from 'vitest'
import {
  ClaudeTranscriptMarkerMissingError,
  createBranchProof
} from './claude-transcript-branch-graph'

const row = (uuid: string, parentUuid: string | null): string =>
  JSON.stringify({ type: 'user', uuid, parentUuid, sessionId: 'provider' })

function build(lines: string[], previousLeafUuid: string | null, tip?: 'marker' | 'file-tail') {
  const builder = createBranchProof({
    providerSessionId: 'provider',
    previousLeafUuid,
    ...(tip === undefined ? {} : { tip })
  })
  for (const [index, line] of lines.entries()) {
    builder.add(line, index, true)
  }
  return builder
}

describe('createBranchProof file-tail tip', () => {
  const MARKERLESS = [row('anchor', null), row('mid', 'anchor'), row('leaf', 'mid')]

  it('proves the tip from the last main-chain row with no last-prompt row anywhere', () => {
    expect(build(MARKERLESS, 'anchor', 'file-tail').finish()).toEqual({
      leafUuid: 'leaf',
      relation: 'descendant'
    })
  })

  it('still requires the marker on the same bytes in marker mode', () => {
    expect(() => build(MARKERLESS, 'anchor').finish()).toThrow(ClaudeTranscriptMarkerMissingError)
  })
})

describe('createBranchProof rows outside the chain', () => {
  // The last record the SDK's forkSession wrote to a real copy, ids as written.
  const FORK_TITLE = JSON.stringify({
    type: 'custom-title',
    sessionId: 'provider',
    customTitle: 'Echo one command (fork)',
    uuid: '0893e55c-8ec1-432e-af73-3bd165648413',
    timestamp: '2026-10-07T18:18:59.625Z'
  })

  it('proves a forked transcript, whose closing title has an id but no parent', () => {
    const lines = [row('anchor', null), row('leaf', 'anchor'), FORK_TITLE]

    expect(build(lines, 'anchor', 'file-tail').finish()).toEqual({
      leafUuid: 'leaf',
      relation: 'descendant'
    })
  })

  it('still refuses a conversation row that names no parent', () => {
    const orphan = JSON.stringify({ type: 'assistant', uuid: 'orphan', sessionId: 'provider' })

    expect(() => build([row('anchor', null), orphan], 'anchor', 'file-tail')).toThrow(
      'record orphan has no parent identity'
    )
  })
})

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
