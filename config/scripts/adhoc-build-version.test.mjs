import { describe, expect, it } from 'vitest'
import {
  createAdhocBuildVersion,
  formatAdhocReleaseName,
  normalizeAdhocLabel
} from './adhoc-build-version.mjs'
import { createHourlyBuildVersion } from './hourly-build-version.mjs'
import { compareAppVersions } from '../../src/shared/app-version'

describe('createAdhocBuildVersion', () => {
  it('stamps the version with a zero-padded UTC timestamp to the second', () => {
    expect(createAdhocBuildVersion('1.4.160', new Date('2026-07-28T04:05:09Z'))).toBe(
      '1.4.160-adhoc.20260728040509'
    )
  })

  // Why seconds matter: adhoc builds are dispatched on demand, so two people
  // cutting from different branches inside the same minute is ordinary. At
  // hourly's resolution the second one would collide on the tag and die after its
  // whole pack-and-notarize run.
  it('distinguishes two builds cut in the same minute', () => {
    const first = createAdhocBuildVersion('1.4.160', new Date('2026-07-28T14:05:02Z'))
    const second = createAdhocBuildVersion('1.4.160', new Date('2026-07-28T14:05:41Z'))
    expect(first).not.toBe(second)
    expect(compareAppVersions(first, second)).toBeLessThan(0)
  })

  it('drops an in-flight rc tail so adhoc builds never outrank the rc series', () => {
    const version = createAdhocBuildVersion('1.4.160-rc.3', new Date('2026-07-28T14:00:00Z'))
    expect(version).toBe('1.4.160-adhoc.20260728140000')
    expect(compareAppVersions(version, '1.4.160-rc.3')).toBeLessThan(0)
    expect(compareAppVersions(version, '1.4.160')).toBeLessThan(0)
  })

  // Why this ordering is load-bearing: an adhoc build is somebody's unlanded
  // branch. It must sit below every other channel of the same base version so no
  // routine check can walk a developer onto one — only an explicit pinned jump.
  it('sorts below the hourly build of the same base version', () => {
    expect(
      compareAppVersions(
        createAdhocBuildVersion('1.4.160', new Date('2026-07-28T23:59:59Z')),
        createHourlyBuildVersion('1.4.160', new Date('2026-07-28T00:00:00Z'))
      )
    ).toBeLessThan(0)
  })

  it('rejects invalid input', () => {
    expect(() => createAdhocBuildVersion('nope', new Date())).toThrow(/valid semver/)
    expect(() => createAdhocBuildVersion('1.4.160', new Date('nope'))).toThrow(/invalid/)
  })
})

describe('normalizeAdhocLabel', () => {
  it('keeps an ordinary branch name intact', () => {
    expect(normalizeAdhocLabel('wasm-terminal')).toBe('wasm-terminal')
    expect(normalizeAdhocLabel('nwparker/wasm-terminal')).toBe('nwparker/wasm-terminal')
  })

  it('strips the ref prefixes a dispatch input tends to arrive with', () => {
    expect(normalizeAdhocLabel('refs/heads/wasm-terminal')).toBe('wasm-terminal')
    expect(normalizeAdhocLabel('origin/wasm-terminal')).toBe('wasm-terminal')
  })

  // Why replaced rather than rejected: the label is free text from whoever ran
  // the workflow. A `•` would forge the title's field separator and a newline
  // would break the `$GITHUB_OUTPUT` line the workflow parses.
  it('neutralizes characters that would corrupt the title or the output line', () => {
    expect(normalizeAdhocLabel('a • b')).toBe('a-b')
    expect(normalizeAdhocLabel('a\nname=evil')).toBe('a-name-evil')
    expect(normalizeAdhocLabel('  spaced   out  ')).toBe('spaced-out')
  })

  it('truncates without leaving a trailing separator', () => {
    expect(normalizeAdhocLabel('a'.repeat(80))).toHaveLength(32)
    expect(normalizeAdhocLabel(`${'a'.repeat(31)}-tail`)).toBe('a'.repeat(31))
  })

  it('rejects a label with nothing usable in it', () => {
    expect(() => normalizeAdhocLabel('')).toThrow(/no usable characters/)
    expect(() => normalizeAdhocLabel('   ')).toThrow(/no usable characters/)
    expect(() => normalizeAdhocLabel('•••')).toThrow(/no usable characters/)
    expect(() => normalizeAdhocLabel(null)).toThrow(/no usable characters/)
  })
})

describe('formatAdhocReleaseName', () => {
  const name = (iso, label = 'wasm-terminal', commit = 'e698241abcde') =>
    formatAdhocReleaseName('1.4.163-adhoc.x', label, commit, new Date(iso))

  it('renders version, label, Pacific timestamp, and short sha', () => {
    expect(name('2026-07-31T20:54:00Z')).toBe('1.4.163 • wasm-terminal • 07-31 13:54 • e698241')
  })

  // Why both sides of DST: the tag's stamp is UTC and the title is Pacific, so
  // the offset between them is not a constant. A test pinned to one season would
  // pass all summer and start failing in November.
  it('follows the Pacific offset across DST', () => {
    expect(name('2026-01-15T02:30:00Z')).toContain(' 01-14 18:30 ')
    expect(name('2026-07-31T07:00:00Z')).toContain(' 07-31 00:00 ')
  })

  it('sanitizes the label before it reaches the title', () => {
    expect(name('2026-07-31T20:54:00Z', 'refs/heads/fix • now')).toBe(
      '1.4.163 • fix-now • 07-31 13:54 • e698241'
    )
  })

  it('rejects an invalid timestamp', () => {
    expect(() => formatAdhocReleaseName('1.4.163', 'x', 'abcdefg', new Date('nope'))).toThrow(
      /invalid/
    )
  })
})
