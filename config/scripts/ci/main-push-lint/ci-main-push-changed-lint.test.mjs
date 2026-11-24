// Pin how the main-push lint reads oxlint output, renders untrusted paths and bounds PR attribution.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { logLine, markdownText, renderLintSummary } from './main-push-report.mjs'
import { collectBatchResults, parseGithubDiagnostics } from './oxlint-batches.mjs'
import {
  attributeFiles,
  choosePull,
  createGithubApi,
  describeAttribution
} from './push-attribution.mjs'

const PANE = 'src/renderer/src/components/browser-pane/stream-remote/remote-browser-page-pane.tsx'
const FINISHED =
  'Found 0 warnings and 1 error.\nFinished in 9ms on 3 files with 96 rules using 4 threads.\n'
const maxLines = (file) =>
  `::error file=${file},line=425,endLine=425,col=2,endColumn=2,title=eslint(max-lines)::${file}:425:2: File has too many lines (402).`

describe('main-push changed-file lint', () => {
  it('decodes oxlint annotations once, keeping file, rule and message', () => {
    const output = [
      maxLines(PANE),
      '::warning file=src/a%2Cb%253A.ts,line=1,endLine=1,col=1,endColumn=9,title=eslint(no-debugger)::src/a,b%253A.ts:1:1: 50%25 off%0Anext',
      '::error title=oxlint::Failed to parse configuration file.'
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
        file: 'src/a,b%3A.ts',
        line: 1,
        col: 1,
        rule: 'eslint(no-debugger)',
        message: '50% off\nnext'
      },
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

  it('counts a batch only when oxlint finished it and explained any failure', () => {
    const result = collectBatchResults([
      { files: ['a.ts'], failed: true, output: `${maxLines(PANE)}\n${FINISHED}` },
      { files: ['b.ts'], failed: true, output: 'thread panicked: out of memory\n' },
      { files: ['c.ts'], failed: false, output: '' },
      { files: ['d.ts'], failed: true, output: FINISHED }
    ])
    expect(result.diagnostics.map((diagnostic) => diagnostic.file)).toEqual([PANE])
    expect(result.linted).toBe(3)
    expect(result.incomplete.map((batch) => batch.files)).toEqual([['b.ts'], ['c.ts'], ['d.ts']])
  })

  it('keeps every untrusted path and message inside its own table cell and log line', () => {
    const hostile = [
      'a|b.ts',
      'tick`x`.ts',
      'new\nline.ts',
      '<img src=x>.ts',
      '*em* [l](u) #1 @u.ts',
      'back\\slash.ts'
    ]
    const diagnostics = hostile.map((file) => ({
      file,
      line: 1,
      col: 1,
      rule: 'r|`',
      message: `m|\n::error::x \`</pre>`
    }))
    const summary = renderLintSummary({
      range: 'a..b',
      scope: 'the files this push changed',
      candidates: hostile.length + 1,
      linted: hostile.length,
      diagnostics,
      incomplete: [{ files: ['x.ts'], output: '```\n</pre><b>raw</b>\n::error::y' }]
    })
    const rows = summary.split('\n').filter((line) => line.startsWith('| <code>'))
    expect(rows).toHaveLength(hostile.length)
    for (const row of rows) {
      expect(row.match(/\|/g)).toHaveLength(4)
      expect(row).not.toMatch(/[`*[\]@\\]|<(?!\/?code>)/)
    }
    expect(summary).not.toMatch(/^::/m)
    expect(summary.match(/<\/pre>/g)).toHaveLength(1)
    for (const diagnostic of diagnostics) {
      expect(logLine(diagnostic)).not.toContain('\n')
    }
    expect(markdownText('x'.repeat(600))).toContain('… (100 more characters)')
  })

  it('stays under the 1 MiB step-summary limit and says what it left out', () => {
    const diagnostics = Array.from({ length: 20_000 }, (_, index) => ({
      file: `${'|'.repeat(80)}${index}.ts`,
      line: 1,
      col: 1,
      rule: 'eslint(max-lines)',
      message: '<'.repeat(400)
    }))
    const summary = renderLintSummary({
      range: 'a..b',
      scope: 's',
      candidates: 1,
      linted: 1,
      diagnostics,
      incomplete: []
    })
    expect(Buffer.byteLength(summary)).toBeLessThan(512 * 1024)
    expect(summary).toMatch(/\d+ more error\(s\) are not shown here/)
  })

  it('accepts only one merged PR into this repo and branch', () => {
    const scope = { repo: 'o/r', ref: 'main' }
    const pull = (number, overrides = {}) => ({
      number,
      merged_at: '2026-01-01',
      user: { login: `u${number}` },
      base: { ref: 'main', repo: { full_name: 'o/r' } },
      ...overrides
    })
    expect(choosePull([pull(1, { merged_at: null }), pull(2)], scope)).toEqual({
      status: 'merged',
      number: 2,
      author: 'u2'
    })
    expect(
      choosePull(
        [
          pull(1, { merged_at: null }),
          pull(3, { base: { ref: 'dev', repo: { full_name: 'o/r' } } })
        ],
        scope
      )
    ).toEqual({ status: 'none' })
    expect(
      choosePull([pull(4, { base: { ref: 'main', repo: { full_name: 'fork/r' } } })], scope)
    ).toEqual({ status: 'none' })
    expect(choosePull([pull(5), pull(6)], scope)).toEqual({ status: 'ambiguous', numbers: [5, 6] })
  })

  it('names only commits inside the push, looks each up once, and labels guesses', async () => {
    const inPush = {
      sha: 'a'.repeat(40),
      author: { login: 'ann' },
      commit: { message: 'fix (#7)' }
    }
    const later = {
      sha: 'b'.repeat(40),
      author: { login: 'bob' },
      commit: { message: 'tidy (#8)' }
    }
    const before = { sha: 'c'.repeat(40), author: { login: 'cy' }, commit: { message: 'old (#9)' } }
    const calls = []
    const api = async (path) => {
      calls.push(path)
      if (path.startsWith('compare/')) {
        return { total_commits: 2, commits: [inPush, later] }
      }
      if (path.startsWith('commits?')) {
        return path.includes('one.ts') ? [later, inPush, before] : [inPush, before]
      }
      if (path === `commits/${inPush.sha}/pulls`) {
        return [
          {
            number: 7,
            merged_at: 'x',
            user: { login: 'ann' },
            base: { ref: 'main', repo: { full_name: 'o/r' } }
          }
        ]
      }
      throw new Error('GitHub API request failed (HTTP 502)')
    }
    const result = await attributeFiles(['one.ts', 'two.ts'], {
      base: 'base',
      head: 'head',
      repo: 'o/r',
      ref: 'main',
      api
    })
    expect(describeAttribution(result.get('one.ts'), 'main')).toBe(
      '2 commits: commit bbbbbbbbbb by @bob (PR lookup unavailable; its subject cites #8, unverified); #7 by @ann (aaaaaaaaaa)'
    )
    expect(describeAttribution(result.get('two.ts'), 'main')).toBe('#7 by @ann (aaaaaaaaaa)')
    expect(calls.filter((path) => path.endsWith('/pulls'))).toHaveLength(2)
  })

  it('stops attribution at the first API failure and within its time budget', async () => {
    let fetches = 0
    const hang = (_url, { signal }) => {
      fetches += 1
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason))
      )
    }
    const limits = { budgetMs: 200, requestTimeoutMs: 5_000, maxRequests: 40, maxFiles: 20 }
    const api = createGithubApi({ GITHUB_REPOSITORY: 'o/r' }, limits, hang)
    const files = Array.from({ length: 30 }, (_, index) => `f${index}.ts`)
    const started = Date.now()
    const result = await attributeFiles(files, {
      base: 'b',
      head: 'h',
      repo: 'o/r',
      ref: 'main',
      api
    })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(fetches).toBe(1)
    expect([...result.values()].every((entry) => entry.status === 'unavailable')).toBe(true)
  })

  it('gives every push its own run, so no push range is dropped', () => {
    const workflow = readFileSync(
      new URL('../../../../.github/workflows/main-push-lint.yml', import.meta.url),
      'utf8'
    )
    expect(workflow).not.toMatch(/^\s*concurrency:/m)
  })
})
