import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DAEMON_PROTOCOL_SOURCE_PATH,
  canAttach,
  crossingRequirements,
  parseDaemonProtocolFacts
} from './daemon-protocol-facts.mjs'

const projectDir = resolve(import.meta.dirname, '../..')

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
  it('reads the working tree declarations and keeps the append-only range', () => {
    const parsed = parseDaemonProtocolFacts(
      readFileSync(join(projectDir, DAEMON_PROTOCOL_SOURCE_PATH), 'utf8')
    )
    expect(parsed.protocolVersion).toBeGreaterThan(1)
    expect(parsed.previousProtocolVersions).toEqual(
      Array.from({ length: parsed.protocolVersion - 1 }, (_, index) => index + 1)
    )
  })

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

describe('protocol crossing', () => {
  const release = facts(37, [36, 35])

  it('lets a same-version or listing candidate adopt the release daemon', () => {
    expect(canAttach(facts(37, [36, 35]), release)).toBe(true)
    expect(canAttach(facts(38, [37, 36, 35]), release)).toBe(true)
  })

  it('rejects a candidate that dropped the release version', () => {
    expect(canAttach(facts(38, [36, 35]), release)).toBe(false)
  })

  it('cannot roll back past a protocol bump', () => {
    expect(canAttach(release, facts(38, [37, 36, 35]))).toBe(false)
    expect(canAttach(release, facts(36, [35]))).toBe(true)
  })

  it('describes the requirements in both directions', () => {
    expect(crossingRequirements(release)).toMatchObject({
      upgrade: 'candidate speaks 37 or lists 37 as previous',
      rollback: expect.stringContaining('35..37')
    })
  })
})
