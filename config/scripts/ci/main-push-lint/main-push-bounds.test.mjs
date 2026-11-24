// Pin the main-push lint's operational bounds: a stalled oxlint run, the log budget, omission notes and
// attribution that can only see one page of GitHub results.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  createReporter,
  reportDiagnostics,
  reportIncomplete
} from './ci-main-push-changed-lint.mjs'
import {
  incompleteHeading,
  renderAttributionSummary,
  renderLintSummary
} from './main-push-report.mjs'
import { collectBatchResults, createBatchCollector, runOxlint } from './oxlint-batches.mjs'
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

  it('keeps only bounded output across several children, digesting each as it ends', async () => {
    // A stand-in oxlint: floods its output on big.ts, otherwise reports one long multibyte error per path.
    const fake = join(scratch, 'fake-flood.mjs')
    writeFileSync(
      fake,
      `const paths = process.argv.slice(process.argv.indexOf('--') + 1)
if (paths.includes('big.ts')) { process.stdout.write('x'.repeat(100_000)) } else {
  for (const p of paths) console.log(\`::error file=\${p},line=1,col=1,title=r::\${p}:1:1: \${'é%25'.repeat(200)}\`)
  console.log(\`Finished in 1ms on \${paths.length} files using 1 threads.\`)
  process.exitCode = 1
}
`
    )
    const collector = createBatchCollector({
      maxDiagnostics: 1,
      maxMessageChars: 50,
      maxExcerptChars: 100
    })
    const kept = await runOxlint(['a.ts', 'big.ts', 'c.ts'], {
      cwd: scratch,
      invocation: { command: process.execPath, prefixArgs: [fake] },
      maxChars: 7,
      maxBuffer: 4_096,
      onResult: collector.add
    })
    expect(kept).toEqual([])
    const result = collector.result()
    expect(result.errorCount).toBe(2)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0].message).toMatch(/^(é%){25}… \(350 more characters\)$/)
    expect(result.linted).toBe(2)
    expect(result.incomplete).toHaveLength(1)
    expect(result.incomplete[0]).toMatchObject({
      files: ['big.ts'],
      reason: 'its output exceeded 4096 bytes'
    })
    // Limits not given fall back to the defaults, so the flood keeps a real, bounded excerpt.
    expect(result.incomplete[0].output.length).toBeGreaterThan(0)
    expect(result.incomplete[0].output.length).toBeLessThan(150)
  })

  it('bounds each annotation after escaping and leaves an unboundable path out of its location', () => {
    const out = captureStdout(() => {
      const reporter = createReporter({})
      reporter.error('t'.repeat(1_000), 'é%\n'.repeat(50_000))
      reportDiagnostics(
        [{ file: 'p'.repeat(600), line: 1, col: 1, rule: 'r', message: 'm' }],
        1,
        reporter
      )
    })
    const [long, , pathless] = out.split('\n')
    expect(Buffer.byteLength(long)).toBeLessThan(10 * 1024)
    expect(long).toContain('more characters')
    expect(pathless).toBe('::error title=r::m')
  })

  it('cites only the unfinished-run details the log really holds', () => {
    const incomplete = Array.from({ length: 11 }, (_, index) => ({
      files: [`f${index}.ts`],
      reason: 'exit code 2',
      output: 'boom'
    }))
    let logged
    const out = captureStdout(() => {
      const reporter = createReporter({})
      // Spend the shared log budget first, as a long run would.
      for (let index = 0; index < 300; index += 1) {
        reporter.log('x'.repeat(1_000))
      }
      logged = reportIncomplete(incomplete, reporter)
    })
    expect(logged).toBe(0)
    expect(out).not.toContain('Not linted:')
    expect(out.match(/^::error title=Main-push lint::/gm)).toHaveLength(10)
    const summary = renderLintSummary({
      range: 'a..b',
      scope: 's',
      candidates: 11,
      linted: 0,
      diagnostics: [],
      incomplete,
      loggedIncomplete: logged
    })
    expect(summary).toContain(
      '6 more group(s) of unlinted paths are not shown here; the step log lists none of the 11.'
    )
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

  it('bounds the policy and directory lists, so they cannot push the summary past its limit', () => {
    const policies = Array.from({ length: 500 }, (_, index) => ({
      dir: `d${index}`,
      path: `d${index}/.oxlintrc.json`,
      why: `${'!'.repeat(450)}${index}`
    }))
    const summary = renderLintSummary({
      range: 'a..b',
      scope: 's',
      candidates: 0,
      dirs: policies.map((policy) => `${'!'.repeat(450)}${policy.dir}`),
      policies,
      linted: 0,
      diagnostics: [],
      incomplete: []
    })
    expect(Buffer.byteLength(summary)).toBeLessThan(128 * 1024)
    expect(summary.match(/; and 490 more/g)).toHaveLength(2)
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

  // MP-C4-05: repeat detection keeps fixed-size keys and stays exact past the kept-error cap.
  it('counts each error once across runs past the kept-error cap, and keeps few excerpts', () => {
    const errorLine = (index) =>
      `::error file=f.ts,line=${index},col=1,title=r::f.ts:${index}:1: ${'界'.repeat(300)} ${index}`
    const run = (indexes, exitCode = 1) => ({
      files: ['f.ts'],
      failed: true,
      exitCode,
      reason: `exit code ${exitCode}`,
      output: `${indexes.map(errorLine).join('\n')}\nFinished in 1ms on 1 file using 1 threads.\n`
    })
    const limits = {
      maxDiagnostics: 1,
      maxMessageChars: 20,
      maxExcerptChars: 50,
      maxIncompleteDetails: 2,
      maxRepeatKeys: 100
    }
    const overlap = { overlap: ['f.ts'] }
    const exact = collectBatchResults(
      [run([1, 2, 3]), run([1, 2, 3]), run([3, 4])],
      limits,
      overlap
    )
    expect(exact).toMatchObject({ errorCount: 4, repeatsUncertain: false })
    expect(exact.diagnostics).toHaveLength(1)
    // A repeat on a printed path that two tracked files can produce may be the second file: kept and flagged.
    const printedTwice = collectBatchResults([run([6]), run([6])], limits, {
      overlap: ['f.ts'],
      uncertain: new Set(['f.ts'])
    })
    expect(printedTwice).toMatchObject({ errorCount: 2, repeatsUncertain: true })
    // Two identical errors in one run can be two files whose printed paths only differ by a backslash: both count.
    expect(collectBatchResults([run([5, 5])], limits, overlap).errorCount).toBe(2)
    const saturated = collectBatchResults(
      [run([1, 2]), run([1, 2])],
      { ...limits, maxRepeatKeys: 1 },
      overlap
    )
    expect(saturated).toMatchObject({ errorCount: 3, repeatsUncertain: true })
    const many = collectBatchResults(
      Array.from({ length: 30 }, () => run([1], 2)),
      limits
    )
    expect(many.incomplete).toHaveLength(30)
    expect(many.incomplete.filter((batch) => batch.output !== '')).toHaveLength(2)
  })

  // MP-C4-06: a spawn failure never ran, a crash after some errors linted part, a deadline skip never ran.
  it('labels a spawn failure, a partial crash and a skipped batch by what oxlint actually did', async () => {
    const enoent = await runOxlint(['a.ts'], {
      cwd: scratch,
      invocation: { command: join(scratch, 'no-such-oxlint'), prefixArgs: [] }
    })
    const partialCrash = {
      files: ['p.ts', 'q.ts'],
      failed: true,
      exitCode: 101,
      reason: 'exit code 101',
      output: '::error file=p.ts,line=1,col=1,title=r::p.ts:1:1: m\nthread panicked\n'
    }
    const skipped = {
      files: ['s.ts'],
      failed: true,
      notRun: true,
      reason: 'not run: the lint time budget ran out',
      output: ''
    }
    // Started, printed nothing, stopped: it may have linted some paths, so they are not "not linted".
    const silent = {
      files: ['z.ts'],
      failed: true,
      reason: 'stopped when the lint time budget ran out',
      output: ''
    }
    const { incomplete } = collectBatchResults([...enoent, partialCrash, skipped, silent])
    expect(incomplete.map((batch) => [incompleteHeading(batch), batch.reason])).toEqual([
      ['1 path(s) were not linted', 'could not run oxlint (ENOENT)'],
      ['oxlint did not finish 2 path(s), after reporting some errors', 'exit code 101'],
      ['1 path(s) were not linted', 'not run: the lint time budget ran out'],
      ['oxlint did not finish 1 path(s)', 'stopped when the lint time budget ran out']
    ])
    let logged
    const out = captureStdout(() => {
      logged = reportIncomplete(incomplete, createReporter({}))
    })
    expect(logged).toBe(4)
    expect(out).toContain('Not fully linted: z.ts')
    expect(out).toContain('Not linted: a.ts')
    expect(out).toContain('Not fully linted: p.ts q.ts')
    expect(out).toContain('Not linted: s.ts')
  })
})
