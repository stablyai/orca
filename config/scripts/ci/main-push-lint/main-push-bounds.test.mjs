// Pin the main-push lint's operational bounds: a stalled oxlint run, the log budget, omission notes and
// attribution that can only see one page of GitHub results.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  createReporter,
  explainPolicies,
  main,
  reportDiagnostics,
  reportIncomplete
} from './ci-main-push-changed-lint.mjs'
import { CONFIG, createGitFixture, DEBUGGER, REPO_ROOT } from './main-push-git-test-fixture.mjs'
import {
  incompleteHeading,
  markdownText,
  renderAttributionSummary,
  renderLintSummary
} from './main-push-report.mjs'
import { collectBatchResults, createBatchCollector, runOxlint } from './oxlint-batches.mjs'
import { attributeFiles, describeAttribution } from './push-attribution.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'orca-main-push-bounds-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

async function captureStdoutAsync(run) {
  const out = []
  const write = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk) => out.push(String(chunk)))
  try {
    await run()
  } finally {
    write.mockRestore()
  }
  return out.join('')
}

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

  // MP-C4-04: the count of policy changes comes first, causes are cut, and unreadable inputs stay visible.
  it('explains policy causes within bounds, keeping counts and unreadable inputs visible', () => {
    const policies = [
      { dir: '.', paths: ['a.json'], unreadable: [], why: `${'w'.repeat(1_000)} root` },
      {
        dir: 'm',
        paths: ['b.json', 'c.json', 'd.json', 'e.json'],
        unreadable: ['x'],
        why: 'm/.oxlintrc.json depends on b.json, c.json, d.json and 1 more, which changed; 1 of its inputs cannot be read'
      },
      {
        dir: 't',
        paths: [],
        unreadable: ['t/oxlint.config.ts is a script config'],
        why: 't/oxlint.config.ts is a script config whose inputs cannot be read, so its scope is linted on every push'
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        dir: `s${index}`,
        paths: [`s${index}.json`],
        unreadable: [],
        why: `s${index} changed`
      }))
    ]
    for (const describe of [
      () => '#7 by @a (aaaaaaaaaa)',
      () => 'unknown (GitHub API request failed (HTTP 503))'
    ]) {
      // Sized for a summary cell: the counts come first, and the first change and its commit always fit.
      const cell = explainPolicies(policies, describe, 'this push')
      expect(cell.length).toBeLessThanOrEqual(440)
      const shown = Number(
        /^7 lint policy change\(s\) cover it, 2 with unreadable inputs; (\d) shown: /.exec(
          cell
        )?.[1]
      )
      expect(shown).toBeGreaterThanOrEqual(1)
      expect(cell).toContain(`${'w'.repeat(120)}… (`)
      expect(cell).toContain(`[1 changed input(s)] (a.json changed by ${describe()})`)
      // Sized for a log line: more changes fit, still with their counts and unreadable markers.
      const line = explainPolicies(policies, describe, 'this push', 800)
      expect(line.length).toBeLessThanOrEqual(800)
      expect(Number(/; (\d) shown: /.exec(line)?.[1])).toBeGreaterThan(shown)
      expect(line).toContain('[4 changed input(s), some unreadable] (b.json changed by')
      expect(line).toContain(
        '[0 changed input(s), some unreadable] (no changed input in this push can be named: its inputs cannot be read)'
      )
    }
  })

  it('makes no GitHub request when there is nothing to look up', async () => {
    let calls = 0
    const api = async () => {
      calls += 1
      return {}
    }
    const result = await attributeFiles([], { base: 'b', head: 'h', repo: 'o/r', ref: 'main', api })
    expect(calls).toBe(0)
    expect(result.size).toBe(0)
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

  // MP-C4-07: a failed lookup of tracked paths after a red lint still prints the verdict.
  it('keeps the verdict when mapping reported paths to tracked files fails', async () => {
    const dir = join(scratch, 'not-a-repo')
    mkdirSync(dir)
    writeFileSync(join(dir, '.oxlintrc.json'), CONFIG)
    writeFileSync(join(dir, 'x.ts'), DEBUGGER)
    const planPath = join(scratch, 'plan.json')
    writeFileSync(
      planPath,
      JSON.stringify({
        event: 'push',
        base: 'a'.repeat(40),
        head: 'b'.repeat(40),
        scope: 'the files this push changed',
        touched: ['x.ts'],
        files: ['x.ts'],
        overlap: [],
        dirs: [],
        policies: [],
        unrepresentable: []
      })
    )
    let exit
    let apiCalls = 0
    const countingApi = async () => {
      apiCalls += 1
      return []
    }
    const text = await captureStdoutAsync(async () => {
      exit = await main({
        env: { MAIN_PUSH_LINT_PLAN: planPath, GITHUB_REPOSITORY: 'o/r' },
        root: dir,
        invocationRoot: REPO_ROOT,
        api: countingApi
      })
    })
    expect(exit).toBe(1)
    expect(text).toContain('Could not map reported paths to tracked files (')
    // The printed path is unverified: no precise location, no PR lookup.
    expect(text).toContain(
      '::error title=eslint(no-debugger)::`debugger` statement is not allowed (oxlint reported x.ts; tracked files could not be read to verify it)'
    )
    expect(text).not.toContain('::error file=')
    expect(text).toContain(
      'x.ts:1:1 (path unverified: tracked files could not be read) eslint(no-debugger)'
    )
    expect(text).toContain(
      'x.ts: not attributed: tracked files could not be read, so this printed path is unverified'
    )
    expect(apiCalls).toBe(0)
  })

  // MP-C5-02: the final log line and summary cell keep every count and the first commit, whatever the causes say.
  it('keeps policy counts, unreadable markers and the first commit in the final log and summary', async () => {
    const fixture = createGitFixture()
    try {
      const origin = fixture.makeOrigin()
      const head = fixture.commit(origin, { '.oxlintrc.json': CONFIG, 'x.ts': DEBUGGER }, 'setup')
      const policies = [
        {
          dir: '.',
          paths: ['a.json', 'b.json'],
          unreadable: ['u'],
          why: `${'W'.repeat(300)} depends on a.json, b.json, which changed; 1 of its inputs cannot be read`
        },
        {
          dir: '.',
          paths: ['cfg.json'],
          unreadable: ['cfg is a script config'],
          why: 'cfg.json was added; 1 of its inputs cannot be read'
        },
        {
          dir: '.',
          paths: [],
          unreadable: ['x'],
          why: `${'L'.repeat(200)}/oxlint.config.ts is a script config whose inputs cannot be read, so its scope is linted on every push`
        },
        ...Array.from({ length: 4 }, (_, index) => ({
          dir: '.',
          paths: [`s${index}.json`],
          unreadable: [],
          why: `s${index}.json changed`
        }))
      ]
      const planPath = join(scratch, 'policy-plan.json')
      writeFileSync(
        planPath,
        JSON.stringify({
          event: 'push',
          base: head,
          head,
          scope: 's',
          touched: [],
          files: [],
          overlap: [],
          dirs: ['.'],
          policies,
          unrepresentable: []
        })
      )
      const succeed = async (path) =>
        path.startsWith('compare/')
          ? { total_commits: 1, commits: [{ sha: head }] }
          : path.startsWith('commits?')
            ? [{ sha: head, author: { login: 'ann' }, commit: { message: 'x (#7)' } }]
            : [
                {
                  number: 7,
                  merged_at: 'x',
                  user: { login: 'ann' },
                  base: { ref: 'main', repo: { full_name: 'o/r' } }
                }
              ]
      const fail = async () => {
        throw new Error('HTTP 503')
      }
      const counts = '7 lint policy change(s) cover it, 3 with unreadable inputs; '
      const cases = [
        { api: succeed, firstCause: '#7 by @ann' },
        { api: fail, firstCause: 'unknown (HTTP 503)' }
      ]
      for (const [index, { api, firstCause }] of cases.entries()) {
        const summaryPath = join(scratch, `policy-summary-${index}.md`)
        const log = await captureStdoutAsync(async () => {
          await main({
            env: {
              MAIN_PUSH_LINT_PLAN: planPath,
              GITHUB_REPOSITORY: 'o/r',
              GITHUB_STEP_SUMMARY: summaryPath
            },
            root: origin,
            invocationRoot: REPO_ROOT,
            api
          })
        })
        const line = log
          .split('\n')
          .find((text) => text.startsWith('x.ts: not changed in this push'))
        expect(line.startsWith(`x.ts: not changed in this push; linted because ${counts}`)).toBe(
          true
        )
        expect(line).toContain(
          `[2 changed input(s), some unreadable] (a.json changed by ${firstCause}`
        )
        expect(line).toContain('[1 changed input(s), some unreadable] (cfg.json changed by')
        const cell = readFileSync(summaryPath, 'utf8')
          .split('\n')
          .find((text) => text.startsWith('| <code>x.ts</code> |'))
        expect(cell).toContain(markdownText(counts))
        expect(cell).toContain(markdownText(`(a.json changed by ${firstCause}`))
        // A cut cause carries its own note inside the cell; the cell itself is never cut, so it ends on a source.
        expect(cell).not.toMatch(/more characters&#41; \|$/)
        expect(cell).toMatch(/&#41; \|$/)
      }
    } finally {
      fixture.cleanup()
    }
  })
})
