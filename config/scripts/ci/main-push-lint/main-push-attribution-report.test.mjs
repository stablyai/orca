// Pin what the main-push lint's attribution and diagnostic report keep under long inputs: policy counts, the first
// commit's SHA, unreadable markers and path notices; and that it looks up only what it can show.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { explainPolicies, main } from './ci-main-push-changed-lint.mjs'
import {
  CONFIG,
  createGitFixture,
  DEBUGGER,
  GIT_TEST_TIMEOUT_MS,
  REPO_ROOT
} from './main-push-git-test-fixture.mjs'
import { markdownText } from './main-push-report.mjs'
import { attributeFiles, compactAttribution, MAX_COMPACT_CHARS } from './push-attribution.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'orca-main-push-report-'))
const fixture = createGitFixture()
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
  fixture.cleanup()
}, GIT_TEST_TIMEOUT_MS)

async function captureStdout(run) {
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

// A failing file about 800 characters long, under four 200-character directories.
const LONG_DIR = Array.from({ length: 4 }, (_, index) => `${String(index).repeat(200)}`).join('/')
const LONG_FILE = `${LONG_DIR}/x.ts`

const policies = [
  {
    dir: '.',
    paths: [`${'p'.repeat(450)}.json`, 'b.json'],
    unreadable: ['u'],
    why: `${'W'.repeat(300)} depends on two inputs, which changed; 1 of its inputs cannot be read`
  },
  {
    dir: '.',
    paths: ['cfg.json'],
    unreadable: ['cfg.json is a script config'],
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
const COUNTS = '7 lint policy change(s) cover it, 3 with unreadable inputs; '

describe('main-push lint attribution report', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it('gives each policy input a short, commit-first attribution', () => {
    const sha = 'c'.repeat(40)
    const merged = { status: 'merged', number: 7, author: 'ann' }
    const found = (commits, partial = false) => ({ status: 'found', commits, partial })
    expect(compactAttribution(found([{ sha, pull: merged }]))).toBe('cccccccccc #7')
    expect(
      compactAttribution(
        found([
          { sha, pull: { status: 'none' } },
          { sha, pull: merged }
        ])
      )
    ).toBe('cccccccccc (no merged PR), +1 more commit(s)')
    expect(compactAttribution(found([{ sha, pull: merged }], true))).toBe(
      'cccccccccc #7, possibly more commits'
    )
    expect(compactAttribution(found([]))).toBe('no commit in this push changed it')
    const failed = compactAttribution({ status: 'unavailable', reason: 'r'.repeat(500) })
    expect(failed).toBe(`lookup unavailable: ${'r'.repeat(49)}…`)
    expect(failed.length).toBeLessThanOrEqual(MAX_COMPACT_CHARS)
  })

  // MP-C5-02: counts first, exact clips, and the first change with its commit always whole.
  it('keeps counts, unreadable markers and the first commit within the cell and log budgets', () => {
    for (const compact of [() => 'aaaaaaaaaa #7', () => 'lookup unavailable: HTTP 503']) {
      const cell = explainPolicies(policies, compact, 'this push')
      expect(cell.length).toBeLessThanOrEqual(440)
      const shown = Number(
        /^7 lint policy change\(s\) cover it, 3 with unreadable inputs; (\d) shown: /.exec(
          cell
        )?.[1]
      )
      expect(shown).toBeGreaterThanOrEqual(1)
      expect(cell).toContain(
        `${'W'.repeat(89)}… [2 changed input(s), some unreadable] (${'p'.repeat(69)}…: ${compact()})`
      )
      const line = explainPolicies(policies, compact, 'this push', 800)
      expect(line.length).toBeLessThanOrEqual(800)
      expect(Number(/; (\d) shown: /.exec(line)?.[1])).toBeGreaterThan(shown)
      expect(line).toContain('[1 changed input(s), some unreadable] (cfg.json: ')
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

  // MP-C5-02 and MP-C6-01 end to end: a long failing filename, a long cause and a long first input; the final
  // log line and summary cell keep the counts and the SHA; only inputs the report can show are looked up.
  it('keeps counts and the first SHA in the final log and summary, and looks up only shown inputs', async () => {
    const origin = fixture.makeOrigin()
    const head = fixture.commit(
      origin,
      { '.oxlintrc.json': CONFIG, [LONG_FILE]: DEBUGGER },
      'setup'
    )
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
    const cases = [
      { outage: false, firstCause: `${head.slice(0, 10)} #7` },
      { outage: true, firstCause: 'lookup unavailable: HTTP 503' }
    ]
    for (const [index, { outage, firstCause }] of cases.entries()) {
      const lookedUp = []
      const api = async (path) => {
        if (outage) {
          throw new Error('HTTP 503')
        }
        if (path.startsWith('compare/')) {
          return { total_commits: 1, commits: [{ sha: head }] }
        }
        if (path.startsWith('commits?')) {
          lookedUp.push(decodeURIComponent(/path=([^&]+)/.exec(path)[1]))
          return [{ sha: head, author: { login: 'ann' }, commit: { message: 'x (#7)' } }]
        }
        return [
          {
            number: 7,
            merged_at: 'x',
            user: { login: 'ann' },
            base: { ref: 'main', repo: { full_name: 'o/r' } }
          }
        ]
      }
      const summaryPath = join(scratch, `policy-summary-${index}.md`)
      const env = {
        MAIN_PUSH_LINT_PLAN: planPath,
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_STEP_SUMMARY: summaryPath
      }
      const log = await captureStdout(() =>
        main({ env, root: origin, invocationRoot: REPO_ROOT, api })
      )
      const line = log.split('\n').find((text) => text.includes(': not changed in this push'))
      expect(line.length).toBeLessThanOrEqual(1_000)
      expect(
        line.startsWith(
          `${LONG_FILE.slice(0, 199)}…: not changed in this push; linted because ${COUNTS}`
        )
      ).toBe(true)
      expect(line).toContain(
        `[2 changed input(s), some unreadable] (${'p'.repeat(69)}…: ${firstCause})`
      )
      const cell = readFileSync(summaryPath, 'utf8')
        .split('\n')
        .find((text) => text.includes(markdownText('not changed in this push')))
      expect(cell).toContain(markdownText(COUNTS))
      expect(cell).toContain(markdownText(`: ${firstCause})`))
      // The cell is never cut: it ends on a source, not on a cut note.
      expect(cell).not.toMatch(/more characters&#41; \|$/)
      if (!outage) {
        // b.json is a second input the report never shows, so it is not looked up.
        expect(lookedUp).not.toContain('b.json')
        for (const input of lookedUp) {
          expect(line).toContain(input.length > 70 ? input.slice(0, 69) : `${input}: `)
        }
      }
    }
  })

  // MP-C5-04: when tracked files cannot be read, the unverified notice leads every surface, whatever follows.
  it('keeps the verdict and the unverified notice when mapping reported paths fails', async () => {
    const dir = join(scratch, 'not-a-repo')
    mkdirSync(join(dir, LONG_DIR), { recursive: true })
    writeFileSync(join(dir, '.oxlintrc.json'), CONFIG)
    writeFileSync(join(dir, LONG_FILE), DEBUGGER)
    const planPath = join(scratch, 'plan.json')
    writeFileSync(
      planPath,
      JSON.stringify({
        event: 'push',
        base: 'a'.repeat(40),
        head: 'b'.repeat(40),
        scope: 'the files this push changed',
        touched: [LONG_FILE],
        files: [LONG_FILE],
        overlap: [],
        dirs: [],
        policies: [],
        unrepresentable: []
      })
    )
    const summaryPath = join(scratch, 'unverified-summary.md')
    let exit
    let apiCalls = 0
    const api = async () => {
      apiCalls += 1
      return []
    }
    const text = await captureStdout(async () => {
      exit = await main({
        env: {
          MAIN_PUSH_LINT_PLAN: planPath,
          GITHUB_REPOSITORY: 'o/r',
          GITHUB_STEP_SUMMARY: summaryPath
        },
        root: dir,
        invocationRoot: REPO_ROOT,
        api
      })
    })
    const notice = '[path unverified: tracked files could not be read]'
    expect(exit).toBe(1)
    expect(text).toContain('Could not map reported paths to tracked files (')
    expect(text).not.toContain('::error file=')
    expect(text).toContain(
      `::error title=eslint(no-debugger)::${notice} oxlint reported ${LONG_FILE.slice(0, 299)}…: `
    )
    expect(text.split('\n').some((line) => line.startsWith(`${notice} ${LONG_DIR}`))).toBe(true)
    const summary = readFileSync(summaryPath, 'utf8')
    expect(summary).toContain(`| <code>${markdownText(notice)}`)
    expect(text).toContain(
      ': not attributed: tracked files could not be read, so this printed path is unverified'
    )
    expect(apiCalls).toBe(0)
  })
})
