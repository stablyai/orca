import { describe, expect, it } from 'vitest'
import { checkPerformanceSection } from '../../../../.github/scripts/check-pr-performance-section.mjs'

describe('Performance section completion', () => {
  it.each([
    ['absent body', undefined, 'missing'],
    ['other sections', '## Testing\nPassed.', 'missing'],
    ['heading suffix', '## Performance measurements\nMeasured 4 ms.', 'missing'],
    ['heading punctuation', '## Performance:\nMeasured 4 ms.', 'missing'],
    ['missing ATX separator', '##Performance\nMeasured 4 ms.', 'missing'],
    ['empty section', '## Performance\n\n## Risk\nLow.', 'empty'],
    ['subheading only', '## Performance\n### Measurements\n', 'empty'],
    ['subheading after None', '## Performance\nNone\n### Evidence\n', 'no-reason'],
    ['template placeholder', '## Performance\nNone, because', 'placeholder'],
    ['split placeholder', '## Performance\nNone,\nbecause …', 'placeholder'],
    ['compact placeholder', '## Performance\nNone,because', 'placeholder'],
    ['formatted placeholder', '## Performance\n**None, because**', 'placeholder'],
    ['bare no-reason', '## Performance\nN/A.', 'no-reason'],
    ['bullet no-reason', '## Performance\n- N/A', 'no-reason'],
    ['formatted no-reason', '## Performance\n**N/A**.', 'no-reason'],
    ['inline no-reason', '## Performance\n`TODO`', 'no-reason'],
    ['task no-reason', '## Performance\n- [ ] _None_', 'no-reason'],
    ['only placeholders', '## Performance\n- N/A\n- TBD', 'no-reason'],
    ['empty list items', '## Performance\n- [ ]\n1.\n---', 'empty'],
    ['first duplicate empty', '## Performance\n## Performance\nA bounded scan.', 'empty'],
    ['next same-level section', '## Performance\n## Testing\nMeasured 4 ms.', 'empty'],
    ['next shallower section', '### Performance\n## Testing\nMeasured 4 ms.', 'empty'],
    ['comment-only answer', '## Performance\n<!-- Add a reason -->', 'empty'],
    ['heading inside comment', '<!--\n## Performance\nA bounded scan.\n-->', 'missing'],
    ['comment must not join label', '## Per<!-- hidden -->formance\nA bounded scan.', 'missing']
  ])('rejects %s', (_name, body, reason) => {
    expect(checkPerformanceSection(body)).toEqual({ ok: false, reason })
  })

  it.each([
    ['reason', '## Performance\nNone, because this only changes documentation.'],
    ['closing hashes and case', ' ### PERFORMANCE ###\nNone, because only docs change.'],
    [
      'bullet evidence',
      '## Performance\n- Adds one cached git call per refresh.\n- Measured 40 worktrees: +3 ms.'
    ],
    ['nested evidence', '## Performance\n### Evidence\nMeasured 4 ms at 100 files.'],
    ['inline measurements', '## Performance\nOne `git rev-parse` per refresh: +3 ms.'],
    ['CRLF', '## Testing\r\nPassed.\r\n## Performance\r\nNone, because only docs change.'],
    ['lone CR and Unicode', '## Performance\rNone, because only the 日本語 documentation changes.'],
    [
      'ordinary reason and later section',
      '## Performance\nNone, because only docs change.\n## Risk\nLow.'
    ]
  ])('accepts %s', (_name, body) => {
    expect(checkPerformanceSection(body)).toEqual({ ok: true, reason: 'ok' })
  })
})

describe('literal code and hidden-region precedence', () => {
  it.each([
    ['inline HTML opener', 'Checked literal `<!--` parsing.'],
    ['inline LoC opener', 'Checked `<!-- orca-pr-loc -->` parsing.'],
    ['inline LoC closer', 'Checked `<!-- /orca-pr-loc -->` parsing.'],
    ['double-backtick literal', 'Checked ``literal ` <!--`` parsing.'],
    ['indented HTML opener', '\n    <!--'],
    ['indented LoC opener', '\n    <!-- orca-pr-loc -->'],
    ['indented LoC closer', '\n    <!-- /orca-pr-loc -->'],
    ['tab-indented literal', '\n\t<!--'],
    ['backtick fence', '```html\n<!--\n<!-- orca-pr-loc -->\n```'],
    ['tilde fence', '~~~html\n<!--\n~~~'],
    ['longer closing fence', '```html\n<!--\n````'],
    ['short fence is not a closer', '````html\n```\n<!--\n````'],
    ['hidden state before indentation', '<!-- real\n    -->'],
    ['hidden state before inline', '<!-- real\n`-->`'],
    ['hidden state ignores fence', '<!-- real\n```\n-->']
  ])('preserves a real section after %s', (_name, prefix) => {
    expect(
      checkPerformanceSection(
        `## Testing\n${prefix}\n\n## Performance\nNone, because this scans a bounded body once.`
      )
    ).toEqual({ ok: true, reason: 'ok' })
  })

  it.each([
    ['unclosed HTML', '<!--'],
    ['unclosed LoC', '<!-- orca-pr-loc -->'],
    ['unmatched inline delimiter', 'An unmatched ` then <!--'],
    ['mismatched inline delimiters', 'An unmatched `` then <!-- `'],
    ['real comment after literal', '`<!--` then <!--'],
    ['real LoC after literal', '`<!-- orca-pr-loc -->` then <!-- orca-pr-loc -->'],
    ['unclosed fence', '```html'],
    ['fence with trailing closer text', '```html\n``` still inside'],
    ['wrong fence character', '```html\n~~~']
  ])('keeps the section hidden after %s', (_name, prefix) => {
    expect(
      checkPerformanceSection(`${prefix}\n## Performance\nNone, because this is hidden.`)
    ).toEqual({ ok: false, reason: 'missing' })
  })

  it('preserves inline literals within the answer without stripping them again', () => {
    expect(
      checkPerformanceSection(
        '## Performance\nNone, because `<!--` and `<!-- orca-pr-loc -->` are scanned once.'
      )
    ).toEqual({ ok: true, reason: 'ok' })
  })

  it.each([
    ['fenced example', '## Testing\n```markdown\n## Performance\nMeasured 4 ms.\n```'],
    ['indented example', '## Testing\n\n    ## Performance\n    Measured 4 ms.'],
    ['fenced answer only', '## Performance\n```\nMeasured 4 ms.\n```'],
    ['indented answer only', '## Performance\n\n    Measured 4 ms.']
  ])('does not count %s as a section or answer', (_name, body) => {
    expect(checkPerformanceSection(body).ok).toBe(false)
  })

  it('does not let fenced headings end an existing section', () => {
    expect(
      checkPerformanceSection('## Performance\n```md\n## Risk\n```\nMeasured 4 ms at 100 files.')
    ).toEqual({ ok: true, reason: 'ok' })
  })
})

describe('generated LoC blocks and bounded bodies', () => {
  it('does not count a generated table appended to an empty Performance section', () => {
    expect(
      checkPerformanceSection(
        '## Performance\n<!-- orca-pr-loc -->\n<!-- Generated -->\n| Test | 4 |\n<!-- /orca-pr-loc -->'
      )
    ).toEqual({ ok: false, reason: 'empty' })
  })

  it('resumes after multiple generated blocks without counting their contents', () => {
    expect(
      checkPerformanceSection(
        '<!-- orca-pr-loc -->\n`<!--`\n<!-- /orca-pr-loc -->\n## Performance\n<!-- orca-pr-loc -->\n| Prod | 2 |\n<!-- /orca-pr-loc -->\nNone, because only docs change.'
      )
    ).toEqual({ ok: true, reason: 'ok' })
  })

  it('hides an apparent answer after near-limit unmatched comment openers', () => {
    expect(
      checkPerformanceSection(`${'<!--'.repeat(16_350)}\n## Performance\nMeasured 4 ms.`)
    ).toEqual({ ok: false, reason: 'missing' })
  })

  it('preserves a valid answer before a large malformed suffix', () => {
    expect(
      checkPerformanceSection(`## Performance\nMeasured 4 ms.\n${'<!--'.repeat(16_350)}`)
    ).toEqual({ ok: true, reason: 'ok' })
  })

  it('preserves a section after many inline literal comment and LoC markers', () => {
    expect(
      checkPerformanceSection(
        `${'Checked `<!--` and `<!-- orca-pr-loc -->`.\n'.repeat(
          1_500
        )}\n## Performance\nNone, because this only changes documentation.`
      )
    ).toEqual({ ok: true, reason: 'ok' })
  })

  it('preserves a section after many distinct unmatched backtick runs', () => {
    const body = Array.from({ length: 340 }, (_, i) => `${'`'.repeat(i + 1)} x `).join('')
    expect(
      checkPerformanceSection(`${body}\n## Performance\nNone, because only docs change.`)
    ).toEqual({ ok: true, reason: 'ok' })
  })

  it('accepts a complete section at the input bound', () => {
    const prefix = '## Performance\nNone, because '
    expect(checkPerformanceSection(prefix + 'x'.repeat(65_536 - prefix.length))).toEqual({
      ok: true,
      reason: 'ok'
    })
  })

  it('rejects an oversized body without truncating it into a passing section', () => {
    expect(
      checkPerformanceSection(`## Performance\nMeasured 4 ms.\n${'x'.repeat(65_536)}`)
    ).toEqual({
      ok: false,
      reason: 'too-large'
    })
  })

  it('rejects a large heading label whose whitespace is followed by a suffix', () => {
    expect(
      checkPerformanceSection(`## Performance${' '.repeat(65_000)}suffix\nMeasured 4 ms.`)
    ).toEqual({ ok: false, reason: 'missing' })
  })
})
