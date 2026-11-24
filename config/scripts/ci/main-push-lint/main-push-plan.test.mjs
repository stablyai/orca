// Pin what a main push lints when it changes lint policy, and that the plan step gates dependency setup.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { main as lint } from './ci-main-push-changed-lint.mjs'
import {
  CLEAN,
  CONFIG,
  DEBUGGER,
  GIT_TEST_TIMEOUT_MS,
  LENIENT,
  REPO_ROOT
} from './main-push-git-test-fixture.mjs'
import { createWorkflowFixture } from './main-push-workflow-test-fixture.mjs'
import { isEmptyPlan, oxlintVersionFromLockfile, planLint } from './main-push-plan.mjs'

const {
  git,
  commit,
  makeOrigin,
  shallowCheckout,
  scratchFile,
  cleanup,
  push,
  planFor,
  runWorkflow
} = createWorkflowFixture()
afterAll(cleanup, GIT_TEST_TIMEOUT_MS)

// The run must fail on the rule itself, on the intended file: a config that fails to load also exits 1.
async function expectDebuggerError(pushed, file) {
  const run = await runWorkflow(pushed)
  expect(run.lintExit).toBe(1)
  expect(run.log).toContain(`::error file=${file},line=1,col=1,title=eslint(no-debugger)::`)
}

const lock = (version) =>
  `importers:\n\n  .:\n    devDependencies:\n      oxlint:\n        specifier: ^${version}\n        version: ${version}(oxlint-tsgolint@7.0.2007)\n`

describe('main-push lint plan', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it('lints only touched source on an ordinary push, leaving older files alone', async () => {
    const pushed = push(
      { '.oxlintrc.json': LENIENT, 'old.ts': DEBUGGER, 'a.ts': CLEAN },
      { 'a.ts': 'export const a = 1\n' }
    )
    expect(await planFor(pushed)).toMatchObject({ files: ['a.ts'], dirs: [], policies: [] })
    const run = await runWorkflow(pushed)
    expect([run.planExit, run.lintExit]).toEqual([0, 0])
  })

  it('lints the whole tree when a stricter root config lands after newer source', async () => {
    // newer.ts passed the old config; the config PR, based on an older main, never saw it.
    const pushed = push(
      { '.oxlintrc.json': LENIENT, 'newer.ts': DEBUGGER },
      { '.oxlintrc.json': CONFIG }
    )
    expect(await planFor(pushed)).toMatchObject({ files: [], dirs: ['.'] })
    const pulls = async (path) =>
      path.startsWith('compare/')
        ? { total_commits: 1, commits: [{ sha: pushed.after }] }
        : path.startsWith('commits?')
          ? [{ sha: pushed.after, author: { login: 'cfg' }, commit: { message: 'push (#2)' } }]
          : []
    const run = await runWorkflow(pushed, pulls)
    expect([run.planExit, run.lintExit]).toEqual([0, 1])
    expect(run.log).toContain('::error file=newer.ts,line=1,col=1,title=eslint(no-debugger)::')
    expect(run.log).toContain(
      `newer.ts: not changed in this push; linted because 1 lint policy change(s) cover it; 1 shown: .oxlintrc.json changed [1 changed input(s)] (.oxlintrc.json: ${pushed.after.slice(0, 10)} (no merged PR))`
    )
    expect(run.summary).toContain('Lint policy changed, so the whole scope it governs is linted')
  })

  it('lints a subtree when its nested exemption is deleted', async () => {
    const pushed = push(
      {
        '.oxlintrc.json': CONFIG,
        'sub/.oxlintrc.json': LENIENT,
        'sub/x.ts': DEBUGGER,
        'top.ts': CLEAN
      },
      { 'sub/.oxlintrc.json': null }
    )
    expect(await planFor(pushed)).toMatchObject({ files: [], dirs: ['sub'] })
    const run = await runWorkflow(pushed)
    expect([run.planExit, run.lintExit]).toEqual([0, 1])
    expect(run.log).toContain('::error file=sub/x.ts,line=1,col=1')
    expect(run.log).not.toContain('file=top.ts')
  })

  it('walks a changed subtree and still lints touched files outside it', async () => {
    const pushed = push(
      {
        '.oxlintrc.json': CONFIG,
        'sub/.oxlintrc.json': LENIENT,
        'sub/old.ts': DEBUGGER,
        'a.ts': CLEAN
      },
      { 'sub/.oxlintrc.json': CONFIG, 'a.ts': DEBUGGER, 'sub/new.ts': CLEAN }
    )
    expect(await planFor(pushed)).toMatchObject({
      touched: ['a.ts', 'sub/new.ts'],
      files: ['a.ts', 'sub/new.ts'],
      overlap: ['sub/new.ts'],
      dirs: ['sub']
    })
    const run = await runWorkflow(pushed)
    expect(run.lintExit).toBe(1)
    expect(run.log).toContain('::error file=sub/old.ts,')
    expect(run.log).toContain('::error file=a.ts,')
  })

  it('follows extends: a config that extends a changed file has its scope linted', async () => {
    const nested = JSON.stringify({ extends: ['../base.json'] })
    const pushed = push(
      {
        '.oxlintrc.json': LENIENT,
        'base.json': LENIENT,
        'm/.oxlintrc.json': nested,
        'm/x.ts': DEBUGGER
      },
      { 'base.json': CONFIG }
    )
    expect(await planFor(pushed)).toMatchObject({
      dirs: ['m'],
      policies: [
        { dir: 'm', paths: ['base.json'], why: 'm/.oxlintrc.json extends base.json, which changed' }
      ]
    })
    await expectDebuggerError(pushed, 'm/x.ts')
  })

  it('follows extends through files of any name, and stops on a cycle', async () => {
    const extend = (target) => JSON.stringify({ extends: [target] })
    const chain = push(
      {
        '.oxlintrc.json': LENIENT,
        'm/.oxlintrc.json': extend('../base.json'),
        'base.json': extend('./rules.json'),
        'rules.json': LENIENT,
        // A cycle that the changed file does not reach.
        'a.json': extend('./b.json'),
        'b.json': extend('./a.json'),
        'm/x.ts': DEBUGGER
      },
      { 'rules.json': CONFIG }
    )
    expect(await planFor(chain)).toMatchObject({
      dirs: ['m'],
      policies: [
        {
          dir: 'm',
          paths: ['rules.json'],
          why: 'm/.oxlintrc.json depends on rules.json, which changed'
        }
      ]
    })
    await expectDebuggerError(chain, 'm/x.ts')
    const cycle = push(
      {
        '.oxlintrc.json': extend('./a.json'),
        'a.json': extend('./b.json'),
        'b.json': extend('./a.json')
      },
      { 'b.json': extend('./a.json').replace('}', ', "rules": {}}') }
    )
    expect(await planFor(cycle)).toMatchObject({ dirs: ['.'] })
  })

  it('keeps a leading U+FEFF in a changed name instead of linting a different file', async () => {
    const bom = '\uFEFFa.ts'
    const pushed = push({ '.oxlintrc.json': CONFIG, 'a.ts': CLEAN }, { [bom]: DEBUGGER })
    expect(await planFor(pushed)).toMatchObject({ files: [bom] })
    await expectDebuggerError(pushed, bom)
  })

  it('treats a new locked oxlint version as a root policy change, and other lockfile edits as none', async () => {
    expect(oxlintVersionFromLockfile(lock('1.94.0'))).toBe('1.94.0')
    const bumped = push({ 'pnpm-lock.yaml': lock('1.94.0') }, { 'pnpm-lock.yaml': lock('1.95.0') })
    expect(await planFor(bumped)).toMatchObject({
      dirs: ['.'],
      policies: [
        { paths: ['pnpm-lock.yaml'], why: 'the locked oxlint version changed (1.94.0 to 1.95.0)' }
      ]
    })
    const other = push(
      { 'pnpm-lock.yaml': lock('1.94.0') },
      { 'pnpm-lock.yaml': `${lock('1.94.0')}  other: {}\n` }
    )
    expect(await planFor(other)).toMatchObject({ dirs: [], policies: [] })
  })

  it('skips dependency setup for a docs-only push and fails an unusable range in the plan step', async () => {
    const docs = await runWorkflow(
      push({ '.oxlintrc.json': CONFIG, 'a.ts': CLEAN }, { 'README.md': '#\n' })
    )
    expect(docs).toMatchObject({ planExit: 0, lintExit: null, output: 'lint=false\n' })
    expect(docs.summary).toContain('Nothing to lint')
    const config = await runWorkflow(
      push({ '.oxlintrc.json': CONFIG }, { '.oxlintrc.json': LENIENT })
    )
    expect(config).toMatchObject({ planExit: 0, lintExit: 0, output: 'lint=true\n' })
    const pushed = push({ 'a.ts': CLEAN }, { 'a.ts': DEBUGGER })
    const broken = await runWorkflow({ ...pushed, before: 'f'.repeat(40) })
    expect(broken).toMatchObject({ planExit: 1, lintExit: null, output: '' })
    expect(broken.log).toMatch(
      /^::error title=Main-push lint::Refusing to narrow the lint range: cannot fetch the push base f+ /m
    )
  })

  it('does not guess why oxlint excluded a path it was given', async () => {
    const run = await runWorkflow(
      push({ '.oxlintrc.json': CONFIG }, { 'bundle.min.js': DEBUGGER, 'a.ts': CLEAN })
    )
    expect(run.lintExit).toBe(0)
    expect(run.summary).toContain(
      'Planned: 2 changed candidate file(s). oxlint reported linting 1 file(s). oxlint excluded the other 1 itself.'
    )
    expect(run.summary).not.toContain('ignorePatterns')
  })

  it('reports a path that is not valid UTF-8 instead of linting a different path', async () => {
    const origin = makeOrigin()
    const before = commit(origin, { '.oxlintrc.json': CONFIG, 'a.ts': CLEAN }, 'setup')
    // Build the commit with plumbing and a scratch index, so no file system has to hold the name and main
    // (which the checkout clones) stays at the clean base.
    const index = { ...process.env, GIT_INDEX_FILE: scratchFile('index') }
    const plumbing = (args, input) =>
      execFileSync('git', args, { cwd: origin, env: index, input, encoding: 'utf8' }).trim()
    plumbing(['read-tree', before])
    const blob = git(origin, 'rev-parse', 'HEAD:a.ts')
    plumbing(
      ['update-index', '--index-info'],
      Buffer.concat([
        Buffer.from(`100644 blob ${blob}\tbad`),
        Buffer.from([0xff]),
        Buffer.from('.ts\n')
      ])
    )
    const after = plumbing(
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        'commit-tree',
        plumbing(['write-tree']),
        '-p',
        before,
        '-m',
        'odd byte'
      ],
      ''
    )
    // Some file systems reject the name, so fetch the pushed commit without checking it out.
    const cwd = shallowCheckout(origin, before)
    git(cwd, 'fetch', '-q', '--depth=1', 'origin', after)
    expect(await planLint({ base: before, head: after, cwd })).toMatchObject({
      files: [],
      unrepresentable: ['bad\\xff.ts']
    })
    const out = []
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => out.push(String(chunk)))
    const summaryPath = scratchFile('summary.md')
    let exit
    try {
      exit = await lint({
        env: {
          GITHUB_EVENT_NAME: 'push',
          BEFORE_SHA: before,
          HEAD_SHA: after,
          GITHUB_STEP_SUMMARY: summaryPath
        },
        root: cwd,
        invocationRoot: REPO_ROOT
      })
    } finally {
      write.mockRestore()
    }
    expect(exit).toBe(1)
    expect(out.join('')).toContain('the path is not valid UTF-8')
    // oxlint never received it, so it is "not linted", not an oxlint run that did not finish.
    const summary = readFileSync(summaryPath, 'utf8')
    expect(summary).toContain('1 path(s) never reached oxlint, so coverage is incomplete')
    expect(summary).toContain('#### 1 path(s) were not linted (the path is not valid UTF-8')
    expect(summary).not.toContain('did not finish')
    expect(out.join('')).toContain('Not linted: bad\\\\xff.ts')

    // Deleting that path leaves nothing to lint.
    plumbing(['read-tree', after])
    plumbing(
      ['update-index', '--index-info'],
      Buffer.concat([
        Buffer.from(`0 ${'0'.repeat(40)}\tbad`),
        Buffer.from([0xff]),
        Buffer.from('.ts\n')
      ])
    )
    const removed = plumbing(
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        'commit-tree',
        plumbing(['write-tree']),
        '-p',
        after,
        '-m',
        'drop odd byte'
      ],
      ''
    )
    git(cwd, 'fetch', '-q', '--depth=1', 'origin', removed)
    const deletion = await planLint({ base: after, head: removed, cwd })
    expect(deletion).toMatchObject({ files: [], dirs: [], unrepresentable: [] })
    expect(isEmptyPlan(deletion)).toBe(true)
  })
})
