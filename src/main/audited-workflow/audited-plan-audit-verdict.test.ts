// Fail-closed tests for verdict parsing and the last-message file contract.
//
// The recurring theme: there is NO input that yields `approved` other than a
// well-formed object that literally says so. Every ambiguity is unparseable.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_LAST_MESSAGE_BYTES,
  parsePlanAuditVerdict,
  readLastMessageFile,
  removeLastMessageFile
} from './audited-plan-audit-verdict'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-verdict-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true })
  }
})

describe('parsePlanAuditVerdict', () => {
  it('parses a bare JSON object', () => {
    const result = parsePlanAuditVerdict(
      '{"verdict":"approved","summary":"Looks right","findings":[]}'
    )
    // `coverage: []` on a payload that never mentioned coverage is the Phase 6
    // no-regression guarantee in its smallest form: a pre-Phase-6 response shape
    // still parses as a valid verdict rather than becoming verdict_unparseable.
    expect(result).toEqual({
      ok: true,
      verdict: 'approved',
      summary: 'Looks right',
      findingCount: 0,
      coverage: []
    })
  })

  it('parses a fenced block and counts findings', () => {
    const result = parsePlanAuditVerdict(
      'Here is my review:\n```json\n{"verdict":"fixes_requested","summary":"Two gaps","findings":[{"text":"a"},{"text":"b"}]}\n```'
    )
    expect(result).toEqual({
      ok: true,
      verdict: 'fixes_requested',
      summary: 'Two gaps',
      findingCount: 2,
      coverage: []
    })
  })

  it('takes the LAST object when a draft precedes the final answer', () => {
    const result = parsePlanAuditVerdict(
      '{"verdict":"blocked","summary":"draft"}\nOn reflection:\n{"verdict":"approved","summary":"final"}'
    )
    expect(result).toMatchObject({ ok: true, verdict: 'approved', summary: 'final' })
  })

  it('handles braces inside string values without closing the object early', () => {
    const result = parsePlanAuditVerdict(
      '{"verdict":"approved","summary":"use ${x} and } carefully","findings":[]}'
    )
    expect(result).toMatchObject({ ok: true, verdict: 'approved' })
  })

  // The guard against the vocabulary drifting back to a parallel union.
  it.each(['accepted', 'changes_requested'])(
    'rejects the non-vocabulary verdict %s rather than mapping it',
    (verdict) => {
      expect(parsePlanAuditVerdict(`{"verdict":"${verdict}","summary":"x"}`)).toEqual({
        ok: false,
        reasonCode: 'verdict_unparseable'
      })
    }
  )

  it.each([
    ['an unknown verdict', '{"verdict":"looks_fine","summary":"x"}'],
    ['a missing verdict', '{"summary":"x"}'],
    ['truncated JSON', '{"verdict":"approved","summary":'],
    ['an empty string', ''],
    ['whitespace only', '   \n  '],
    ['prose with no object', 'The plan seems fine to me.'],
    ['a non-object', '"approved"']
  ])('fails closed on %s', (_label, input) => {
    expect(parsePlanAuditVerdict(input)).toEqual({
      ok: false,
      reasonCode: 'verdict_unparseable'
    })
  })

  it('does not accept a verdict from stdout-shaped banner text', () => {
    // Raw stdout is never the verdict source; this asserts that even if such
    // text reached the parser it yields nothing usable.
    const stdout = [
      'sandbox: read-only',
      'session id: 019fc907',
      'hook: SessionStart',
      'codex',
      'The plan is approved.',
      'tokens used',
      '13 119'
    ].join('\n')
    expect(parsePlanAuditVerdict(stdout)).toEqual({
      ok: false,
      reasonCode: 'verdict_unparseable'
    })
  })
})

describe('readLastMessageFile', () => {
  it('reads a normal result file', () => {
    const dir = tempDir()
    const path = join(dir, 'last-message.txt')
    writeFileSync(path, '{"verdict":"approved"}', 'utf8')
    expect(readLastMessageFile(path)).toEqual({ ok: true, text: '{"verdict":"approved"}' })
  })

  it('fails closed when the file is missing', () => {
    expect(readLastMessageFile(join(tempDir(), 'nope.txt'))).toEqual({
      ok: false,
      reasonCode: 'verdict_unparseable'
    })
  })

  it('fails closed on an empty file', () => {
    const dir = tempDir()
    const path = join(dir, 'last-message.txt')
    writeFileSync(path, '', 'utf8')
    expect(readLastMessageFile(path)).toEqual({ ok: false, reasonCode: 'verdict_unparseable' })
  })

  it('fails closed when the file exceeds the cap', () => {
    const dir = tempDir()
    const path = join(dir, 'last-message.txt')
    writeFileSync(path, 'x'.repeat(MAX_LAST_MESSAGE_BYTES + 1), 'utf8')
    expect(readLastMessageFile(path)).toEqual({ ok: false, reasonCode: 'verdict_unparseable' })
  })

  it('fails closed when a directory sits at the path', () => {
    const dir = tempDir()
    const path = join(dir, 'last-message.txt')
    mkdirSync(path)
    expect(readLastMessageFile(path)).toEqual({ ok: false, reasonCode: 'verdict_unparseable' })
  })

  it('cannot read a previous run result: paths are run-id scoped', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'rev_old'))
    writeFileSync(join(dir, 'rev_old', 'last-message.txt'), '{"verdict":"approved"}', 'utf8')
    // A different run id resolves to a different directory, so the stale file is
    // simply not found.
    expect(readLastMessageFile(join(dir, 'rev_new', 'last-message.txt'))).toEqual({
      ok: false,
      reasonCode: 'verdict_unparseable'
    })
  })
})

// Phase 6. The governing rule: coverage is BOOKKEEPING and must never be able to
// fail a verdict. Anything wrong with the coverage array either parses to a safe
// value or, when the array itself is malformed, falls back to the same
// verdict_unparseable every other malformed payload already yields — never to a
// silently-covered criterion.
describe('parsePlanAuditVerdict coverage', () => {
  const withCoverage = (coverage: string): string =>
    `{"verdict":"approved","summary":"s","coverage":${coverage}}`

  it('parses entries and normalizes a missing note to null', () => {
    const result = parsePlanAuditVerdict(
      withCoverage('[{"id":"ac1","covered":true,"note":"Step 3"},{"id":"ac2","covered":false}]')
    )
    expect(result).toEqual({
      ok: true,
      verdict: 'approved',
      summary: 's',
      findingCount: 0,
      coverage: [
        { id: 'ac1', covered: true, note: 'Step 3' },
        { id: 'ac2', covered: false, note: null }
      ]
    })
  })

  it('normalizes a whitespace-only note to null', () => {
    const result = parsePlanAuditVerdict(withCoverage('[{"id":"ac1","covered":true,"note":"   "}]'))
    expect(result.ok && result.coverage).toEqual([{ id: 'ac1', covered: true, note: null }])
  })

  it('accepts an explicitly empty coverage array', () => {
    const result = parsePlanAuditVerdict(withCoverage('[]'))
    expect(result.ok && result.coverage).toEqual([])
  })

  // R2. A malformed coverage array fails the WHOLE verdict rather than being
  // dropped: a payload this broken is not one whose verdict field can be trusted
  // either, and the fail-closed default must be "no approval", not "approved with
  // coverage quietly discarded".
  it.each([
    ['a non-boolean covered', '[{"id":"ac1","covered":"yes"}]'],
    ['a missing id', '[{"covered":true}]'],
    ['a blank id', '[{"id":"  ","covered":true}]'],
    ['an extra key', '[{"id":"ac1","covered":true,"evil":1}]'],
    ['a non-array', '{"ac1":true}'],
    [
      'more than 20 entries',
      `[${Array.from({ length: 21 }, (_, i) => `{"id":"a${i}","covered":true}`).join(',')}]`
    ]
  ])('rejects the whole verdict for %s', (_label, coverage) => {
    expect(parsePlanAuditVerdict(withCoverage(coverage))).toEqual({
      ok: false,
      reasonCode: 'verdict_unparseable'
    })
  })

  it('never yields approved from a coverage array alone', () => {
    expect(parsePlanAuditVerdict('{"coverage":[{"id":"ac1","covered":true}]}')).toEqual({
      ok: false,
      reasonCode: 'verdict_unparseable'
    })
  })
})

describe('removeLastMessageFile', () => {
  it('removes the file so a partial result cannot be read later', () => {
    const dir = tempDir()
    const path = join(dir, 'last-message.txt')
    writeFileSync(path, '{"verdict":"approved"}', 'utf8')
    removeLastMessageFile(path)
    expect(readLastMessageFile(path)).toEqual({ ok: false, reasonCode: 'verdict_unparseable' })
  })

  it('never throws when the file is already gone', () => {
    expect(() => removeLastMessageFile(join(tempDir(), 'missing.txt'))).not.toThrow()
  })
})
