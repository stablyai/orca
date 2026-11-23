// Pin how the main-push lint reads oxlint output and names the PR behind a failure.
import { describe, expect, it } from 'vitest'
import {
  describeIntroducer,
  describeIntroducers,
  isMissingSha,
  lintableFiles,
  parseGithubDiagnostics,
  pullNumberFromSubject,
  renderSummary
} from './ci-main-push-changed-lint.mjs'

const PANE = 'src/renderer/src/components/browser-pane/stream-remote/remote-browser-page-pane.tsx'

describe('main-push changed-file lint', () => {
  it('treats a missing or all-zero before SHA as unusable', () => {
    expect(isMissingSha(undefined)).toBe(true)
    expect(isMissingSha('')).toBe(true)
    expect(isMissingSha('0000000000000000000000000000000000000000')).toBe(true)
    expect(isMissingSha('465241f6d0738')).toBe(false)
  })

  it('keeps only files oxlint lints', () => {
    expect(
      lintableFiles([
        'a.ts',
        'b.tsx',
        'c.mjs',
        'd.cts',
        'e.jsx',
        'f.vue',
        'package.json',
        'README.md',
        '.github/workflows/main-blocking-work.yml',
        'g.d.ts'
      ])
    ).toEqual(['a.ts', 'b.tsx', 'c.mjs', 'd.cts', 'e.jsx', 'f.vue', 'g.d.ts'])
  })

  it('parses oxlint github annotations into file, rule and message', () => {
    const output = [
      `::error file=${PANE},line=425,endLine=425,col=2,endColumn=2,title=eslint(max-lines)::${PANE}:425:2: File has too many lines (402).`,
      '::warning file=src/a%2Cb.ts,line=1,endLine=1,col=1,endColumn=9,title=eslint(no-debugger)::src/a,b.ts:1:1: 50%25 off%0Anext line',
      '',
      'Found 0 warnings and 1 error.'
    ].join('\n')
    expect(parseGithubDiagnostics(output)).toEqual([
      {
        severity: 'error',
        file: PANE,
        line: 425,
        col: 2,
        rule: 'eslint(max-lines)',
        message: 'File has too many lines (402).'
      },
      {
        severity: 'warning',
        file: 'src/a,b.ts',
        line: 1,
        col: 1,
        rule: 'eslint(no-debugger)',
        message: '50% off\nnext line'
      }
    ])
  })

  it('keeps fileless errors with no location', () => {
    expect(
      parseGithubDiagnostics('::error title=oxlint::Failed to parse configuration file.')
    ).toEqual([
      {
        severity: 'error',
        file: null,
        line: null,
        col: null,
        rule: 'oxlint',
        message: 'Failed to parse configuration file.'
      }
    ])
  })

  it('lists a fileless error in the summary without attribution', () => {
    const summary = renderSummary({
      base: '67ca2655a7b7d0000',
      head: '465241f6d0738aaaa',
      files: ['a.ts'],
      diagnostics: [
        {
          severity: 'error',
          file: null,
          line: null,
          col: null,
          rule: 'oxlint',
          message: 'Bad config.'
        }
      ],
      introducers: new Map()
    })
    expect(summary).toContain('| `(no file)` | `oxlint` | Bad config. | n/a |')
  })

  it('reads the squash-merge PR number from a commit subject', () => {
    expect(
      pullNumberFromSubject(
        'fix(browser): hover, drag, modifier clicks, cursor and link bubble on Server pages (#47119)'
      )
    ).toBe(47119)
    expect(pullNumberFromSubject('Merge branch main')).toBeNull()
    expect(pullNumberFromSubject(undefined)).toBeNull()
  })

  it('names the PR and author, or says why it cannot', () => {
    const sha = '465241f6d0738aaaaaaaaaaaaaaaaaaaaaaaaaaa'
    expect(describeIntroducer({ sha, pull: 47119, author: 'octocat' })).toBe(
      '#47119 by @octocat (465241f6d0)'
    )
    expect(describeIntroducer({ sha, pull: null, author: 'octocat' })).toBe(
      'commit 465241f6d0 by @octocat (no PR found)'
    )
    expect(describeIntroducer({ sha, pull: null, author: null, pullLookupFailed: true })).toBe(
      'commit 465241f6d0 (PR lookup failed)'
    )
  })

  it('attributes directly only when one commit in the push changed the file', () => {
    const first = { sha: '1111111111aaaa', pull: 1, author: 'a' }
    const second = { sha: '2222222222bbbb', pull: 2, author: 'b' }
    expect(describeIntroducers([first])).toBe('#1 by @a (1111111111)')
    expect(describeIntroducers([second, first])).toBe(
      'one of #2 by @b (2222222222), #1 by @a (1111111111) (2 commits in this push changed the file)'
    )
    expect(describeIntroducers([])).toMatch(/^unknown/)
    expect(describeIntroducers(undefined)).toMatch(/^unknown/)
  })

  it('renders a failure table naming the offending file, rule and PR', () => {
    const summary = renderSummary({
      base: '67ca2655a7b7d0000',
      head: '465241f6d0738aaaa',
      files: [PANE],
      diagnostics: [
        {
          severity: 'error',
          file: PANE,
          line: 425,
          col: 2,
          rule: 'eslint(max-lines)',
          message: 'File has too many lines (402).'
        }
      ],
      introducers: new Map([[PANE, [{ sha: '465241f6d0738aaaa', pull: 47119, author: 'octocat' }]]])
    })
    expect(summary).toContain('### Main-push lint failed')
    expect(summary).toContain(
      `| \`${PANE}:425\` | \`eslint(max-lines)\` | File has too many lines (402). | #47119 by @octocat (465241f6d0) |`
    )
  })

  it('renders a pass line with the linted range', () => {
    expect(
      renderSummary({
        base: 'c844782e3f4ee000',
        head: '4c4cdf5beada5000',
        files: ['a.ts', 'b.ts'],
        diagnostics: [],
        introducers: new Map()
      })
    ).toBe(
      '### Main-push lint passed\n\n2 changed lintable file(s) in `c844782e3f..4c4cdf5bea` are clean.\n'
    )
  })
})
