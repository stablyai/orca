import { describe, expect, it } from 'vitest'
import { parseDaemonProtocolFacts } from './daemon-protocol-facts.mjs'

function source(current, previous) {
  return [
    `export const PROTOCOL_VERSION = ${current}`,
    'export const OTHER_DAEMON_PROTOCOL_VERSION = 5',
    `export const PREVIOUS_DAEMON_PROTOCOL_VERSIONS = [${previous}] as const`
  ].join('\n')
}

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

  it.each([
    ['a missing PROTOCOL_VERSION', 'export const PREVIOUS_DAEMON_PROTOCOL_VERSIONS = [1]'],
    ['a missing previous list', 'export const PROTOCOL_VERSION = 2'],
    ['a non-literal PROTOCOL_VERSION', source('NEXT_VERSION', '1')],
    ['a spread in the previous list', source(3, '...LEGACY, 2')],
    ['a comment in the previous list', source(3, '1, // legacy\n 2')],
    ['an empty previous list past v1', source(3, '')],
    ['a previous version at or above current', source(3, '1, 2, 3')],
    ['a duplicate declaration', `${source(3, '1, 2')}\nexport const PROTOCOL_VERSION = 4`],
    [
      'a list moved behind a constant',
      'export const PROTOCOL_VERSION = 3\nexport const PREVIOUS_DAEMON_PROTOCOL_VERSIONS = LEGACY'
    ]
  ])('fails loudly on %s', (_name, text) => {
    expect(() => parseDaemonProtocolFacts(text, 'fixture.ts')).toThrow(/fixture\.ts/)
  })
})
