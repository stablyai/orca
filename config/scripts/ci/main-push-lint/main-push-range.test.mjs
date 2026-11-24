// Pin which files a main push lints, against real shallow clones and the real oxlint.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { resolveOxlintInvocation } from '../../tool-invocation/oxlint-cli-invocation.mjs'
import { main } from './ci-main-push-changed-lint.mjs'
import { changedLintableFiles, EMPTY_TREE_SHA, resolveRange } from './main-push-range.mjs'
import { collectBatchResults, runOxlint } from './oxlint-batches.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '../../../..')
const scratch = mkdtempSync(join(tmpdir(), 'orca-main-push-lint-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' }
  ).trim()
}

function commit(cwd, files, message) {
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(cwd, file), content)
  }
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

let counter = 0
function makeOrigin() {
  const origin = join(scratch, `origin-${counter++}`)
  git(scratch, 'init', '-q', '-b', 'main', origin)
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
  return origin
}

// The Actions checkout: one commit deep, so the push base must be fetched.
function shallowCheckout(origin) {
  const checkout = join(scratch, `checkout-${counter++}`)
  git(scratch, 'clone', '-q', '--depth=1', '--no-local', `file://${origin}`, checkout)
  return checkout
}

const DEBUGGER = 'debugger\n'
const CONFIG = JSON.stringify({ rules: { 'no-debugger': 'error' } })

describe('main-push lint range', () => {
  const origin = makeOrigin()
  const root = commit(origin, { '.oxlintrc.json': CONFIG, 'root.ts': 'export {}\n' }, 'root')
  git(origin, 'branch', 'rewritten')
  const early = commit(origin, { 'early.ts': DEBUGGER }, 'early (#1)')
  const head = commit(origin, { 'late.ts': 'export {}\n', 'notes.md': '#\n' }, 'late (#2)')
  git(origin, 'checkout', '-q', 'rewritten')
  const divergent = commit(origin, { 'root.ts': 'export const x = 1\n', 'gone.ts': '' }, 'old tip')
  git(origin, 'checkout', '-q', 'main')

  async function lintScope(event, before, cwd = shallowCheckout(origin)) {
    const { base } = await resolveRange({ event, before, head, cwd })
    return { base, files: await changedLintableFiles(base, head, cwd) }
  }

  it('lints every commit of an ordinary push, not just the last', async () => {
    expect(await lintScope('push', root)).toEqual({ base: root, files: ['early.ts', 'late.ts'] })
  })

  it('diffs a forced push against its old tip even without shared history', async () => {
    expect(await lintScope('push', divergent)).toEqual({
      base: divergent,
      files: ['early.ts', 'late.ts', 'root.ts']
    })
  })

  it('fails instead of narrowing when the push base cannot be fetched', async () => {
    await expect(lintScope('push', 'f'.repeat(40))).rejects.toThrow(
      /refusing to narrow the lint range/
    )
  })

  it('lints every file when the push created the branch', async () => {
    expect(await lintScope('push', '0'.repeat(40))).toEqual({
      base: EMPTY_TREE_SHA,
      files: ['early.ts', 'late.ts', 'root.ts']
    })
  })

  it("lints a manual run's head commit, fetching its parent", async () => {
    expect(await lintScope('workflow_dispatch', undefined)).toEqual({
      base: early,
      files: ['late.ts']
    })
  })

  // GitHub starts a run per push and, with no concurrency group, never replaces a pending one;
  // each run then lints its own before..after, so a push no later push touches is still linted.
  it('lints a middle push in its own run when pushes A, B and C land back to back', async () => {
    const pushes = makeOrigin()
    const start = commit(pushes, { '.oxlintrc.json': CONFIG }, 'start')
    const a = commit(pushes, { 'a.ts': 'export {}\n' }, 'A')
    const b = commit(pushes, { 'only-in-b.ts': DEBUGGER }, 'B')
    const c = commit(pushes, { 'c.ts': 'export {}\n' }, 'C')
    const runs = []
    for (const [before, tip] of [
      [start, a],
      [a, b],
      [b, c]
    ]) {
      // Like actions/checkout, each run fetches only its own pushed commit.
      const cwd = shallowCheckout(pushes)
      git(cwd, 'fetch', '-q', '--depth=1', 'origin', tip)
      git(cwd, 'checkout', '-q', '--detach', tip)
      const { base } = await resolveRange({ event: 'push', before, head: tip, cwd })
      runs.push(await changedLintableFiles(base, tip, cwd))
    }
    expect(runs).toEqual([['a.ts'], ['only-in-b.ts'], ['c.ts']])
  })

  it('treats a real root commit as a change from the empty tree', async () => {
    const lone = makeOrigin()
    const only = commit(lone, { 'a.ts': '' }, 'root')
    const cwd = shallowCheckout(lone)
    expect(await resolveRange({ event: 'workflow_dispatch', head: only, cwd })).toMatchObject({
      base: EMPTY_TREE_SHA
    })
  })

  // Pipes, backticks and newlines are not valid Windows file names.
  it.skipIf(process.platform === 'win32')(
    'lints option-shaped and odd paths with correct locations',
    async () => {
      const odd = ['--format=x.ts', '-dash.ts', 'a|b`c.ts', 'new\nline.ts', 'p%:,q.ts', 'plain.ts']
      const lone = makeOrigin()
      commit(lone, { '.oxlintrc.json': CONFIG }, 'config')
      const tip = commit(lone, Object.fromEntries(odd.map((file) => [file, DEBUGGER])), 'odd paths')
      const cwd = shallowCheckout(lone)
      const { base } = await resolveRange({ event: 'workflow_dispatch', head: tip, cwd })
      const files = await changedLintableFiles(base, tip, cwd)
      expect(files.toSorted()).toEqual(odd.toSorted())
      const results = collectBatchResults(
        await runOxlint(files, { cwd, invocation: resolveOxlintInvocation(REPO_ROOT) })
      )
      expect(results.incomplete).toEqual([])
      expect(results.linted).toBe(odd.length)
      expect(
        results.diagnostics.map((diagnostic) => `${diagnostic.file}:${diagnostic.line}`).toSorted()
      ).toEqual(odd.map((file) => `${file}:1`).toSorted())
    }
  )

  it('publishes the failure before any PR lookup, and exits 1', async () => {
    const cwd = shallowCheckout(origin)
    const summaryPath = join(scratch, `summary-${counter++}.md`)
    const out = []
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => out.push(String(chunk)))
    let seenAtLookup
    const api = async () => {
      seenAtLookup = { summary: readFileSync(summaryPath, 'utf8'), log: out.join('') }
      throw new Error('GitHub API request failed (HTTP 503)')
    }
    const env = {
      GITHUB_EVENT_NAME: 'push',
      BEFORE_SHA: root,
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_STEP_SUMMARY: summaryPath
    }
    try {
      // The checkout supplies the config; the repo root supplies the oxlint binary.
      expect(await main({ env, root: cwd, api, invocationRoot: REPO_ROOT })).toBe(1)
    } finally {
      write.mockRestore()
    }
    expect(seenAtLookup.summary).toContain('### Main-push lint failed')
    expect(seenAtLookup.summary).toContain('<code>early.ts')
    expect(seenAtLookup.log).toContain(
      '::error file=early.ts,line=1,col=1,title=eslint(no-debugger)::'
    )
    expect(out.join('')).toContain(
      'early.ts: changed in this push by unknown (GitHub API request failed (HTTP 503))'
    )
  })
})
