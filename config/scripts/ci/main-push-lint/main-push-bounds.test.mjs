// Pin the main-push lint's operational bounds: a stalled oxlint run, the log budget, omission notes and
// attribution that can only see one page of GitHub results.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createReporter } from './ci-main-push-changed-lint.mjs'
import { renderAttributionSummary, renderLintSummary } from './main-push-report.mjs'
import { collectBatchResults, runOxlint } from './oxlint-batches.mjs'
import { attributeFiles, describeAttribution } from './push-attribution.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'orca-main-push-bounds-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function captureStdout(run) {
  const out = []
  const write = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk) => out.push(String(chunk)))
  try {
    run()
  } finally {
    write.mockRestore()
  }
  return out.join('')
}

const sha = (index) => index.toString(16).padStart(40, '0')
const commitEntry = (index) => ({
  sha: sha(index),
  author: { login: 'a' },
  commit: { message: 'x' }
})

describe('main-push lint bounds', () => {
  it('stops a stalled oxlint run at the lint deadline and keeps what earlier batches found', async () => {
    // A stand-in oxlint: hangs on slow.ts, otherwise reports one error per path and finishes.
    const fake = join(scratch, 'fake-oxlint.mjs')
    writeFileSync(
      fake,
      `const paths = process.argv.slice(process.argv.indexOf('--') + 1)
if (paths.includes('slow.ts')) { setTimeout(() => {}, 60_000) } else {
  for (const p of paths) console.log(\`::error file=\${p},line=1,col=1,title=eslint(no-debugger)::\${p}:1:1: no\`)
  console.log(\`Finished in 1ms on \${paths.length} files using 1 threads.\`)
  process.exitCode = 1
}
`
    )
    const started = Date.now()
    const batches = await runOxlint(['fast.ts', 'slow.ts', 'late.ts'], {
      cwd: scratch,
      invocation: { command: process.execPath, prefixArgs: [fake] },
      budgetMs: 5_000,
      maxChars: 8
    })
    expect(Date.now() - started).toBeLessThan(20_000)
    const result = collectBatchResults(batches)
    expect(result.diagnostics.map((diagnostic) => diagnostic.file)).toEqual(['fast.ts'])
    expect(result.linted).toBe(1)
    expect(result.incomplete.map(({ files, reason }) => [files, reason])).toEqual([
      [['slow.ts'], 'stopped when the lint time budget ran out'],
      [['late.ts'], 'not run: the lint time budget ran out']
    ])
  })

  it('keeps the log within its budget and says how much it left out', () => {
    const out = captureStdout(() => {
      const reporter = createReporter({})
      for (let index = 0; index < 2_000; index += 1) {
        reporter.log(`${index} ${'x'.repeat(5_000)}`)
      }
      reporter.writeEscaped('diagnostic line, outside the shared budget')
      for (let index = 0; index < 100; index += 1) {
        reporter.error('t', 'm')
      }
      reporter.finish()
    })
    expect(Buffer.byteLength(out)).toBeLessThan(300 * 1024)
    // Each line is cut to 1,000 characters, so 256 KiB holds about 260 of them.
    expect(out).toMatch(/\n17\d\d more log line\(s\) were omitted after the 256 KiB log budget\.\n/)
    expect(out).toContain('diagnostic line, outside the shared budget')
    expect(out.match(/^::error /gm)).toHaveLength(31)
    expect(out).toContain('69 more error annotation(s) were omitted.')
  })

  it('names how many rows the log really holds when the summary leaves some out', () => {
    const diagnostics = Array.from({ length: 3_000 }, (_, index) => ({
      file: `${'d/'.repeat(100)}${index}.ts`,
      line: 1,
      col: 1,
      rule: 'r',
      message: 'm'.repeat(400)
    }))
    const summary = renderLintSummary({
      range: 'a..b',
      scope: 's',
      candidates: 3_000,
      linted: 3_000,
      diagnostics,
      incomplete: [],
      loggedDiagnostics: 1_000
    })
    expect(summary).toMatch(
      /\d+ more error\(s\) are not shown here; the step log lists the first 1000 of 3000\./
    )
    const rows = Array.from({ length: 3_000 }, (_, index) => ({
      file: `${'f/'.repeat(100)}${index}.ts`,
      description: 'd'.repeat(300)
    }))
    expect(renderAttributionSummary(rows, { logged: 250 })).toMatch(
      /\d+ more file\(s\) are not shown here; the step log lists the first 250 of 3000\./
    )
  })

  it('labels attribution partial when GitHub returns a full page of push commits or PRs', async () => {
    const pushSize = 150
    const api = async (path) => {
      if (path.startsWith('compare/')) {
        return {
          total_commits: pushSize,
          commits: Array.from({ length: pushSize }, (_, index) => commitEntry(index))
        }
      }
      if (path.startsWith('commits?')) {
        expect(path).toContain('per_page=100')
        return Array.from({ length: 100 }, (_, index) => commitEntry(index))
      }
      // A full page of associated PRs cannot show that one is the only merged PR.
      return Array.from({ length: 100 }, (_, index) => ({
        number: index,
        merged_at: 'x',
        base: { ref: 'main', repo: { full_name: 'o/r' } }
      }))
    }
    const result = await attributeFiles(['big.ts'], {
      base: 'b',
      head: 'h',
      repo: 'o/r',
      ref: 'main',
      api
    })
    const text = describeAttribution(result.get('big.ts'), 'main')
    expect(text).toMatch(/^at least 100 commits, listing stopped at one page of 100: /)
    expect(text).toContain('(PR lookup incomplete: 100 or more associated PRs)')

    // One more than the push's size shows where its commits end, so a short push is complete.
    const short = async (path) =>
      path.startsWith('compare/')
        ? { total_commits: 2, commits: [commitEntry(1), commitEntry(2)] }
        : path.startsWith('commits?')
          ? (expect(path).toContain('per_page=3'), [commitEntry(2), commitEntry(1), commitEntry(9)])
          : []
    const complete = await attributeFiles(['a.ts'], {
      base: 'b',
      head: 'h',
      repo: 'o/r',
      ref: 'main',
      api: short
    })
    expect(describeAttribution(complete.get('a.ts'), 'main')).toMatch(/^2 commits: /)
  })
})
