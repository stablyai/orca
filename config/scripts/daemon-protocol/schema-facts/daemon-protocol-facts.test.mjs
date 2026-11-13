import { describe, expect, it } from 'vitest'
import { parseDaemonProtocolFacts } from './daemon-protocol-facts.mjs'

const facts = (protocolVersion, previousProtocolVersions) => ({
  protocolVersion,
  previousProtocolVersions
})

describe('parseDaemonProtocolFacts', () => {
  it('parses multi-line lists and type annotations', () => {
    const text = [
      '// PROTOCOL_VERSION = 99 in a comment is ignored',
      'export const PROTOCOL_VERSION: number = 4',
      'export const PREVIOUS_DAEMON_PROTOCOL_VERSIONS: readonly number[] = [',
      '  1, 2,',
      '  3,',
      ']'
    ].join('\n')
    expect(parseDaemonProtocolFacts(text)).toEqual(facts(4, [1, 2, 3]))
  })

  it('rejects a non-literal protocol declaration with its source label', () => {
    const text =
      'export const PROTOCOL_VERSION = NEXT_VERSION\nexport const PREVIOUS_DAEMON_PROTOCOL_VERSIONS = [1] as const'
    expect(() => parseDaemonProtocolFacts(text, 'fixture.ts')).toThrow(/fixture\.ts/)
  })
})
