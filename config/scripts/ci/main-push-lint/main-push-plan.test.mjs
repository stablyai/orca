// Pin what a main push lints when it changes lint policy, and that the plan step gates dependency setup.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { main as lint } from './ci-main-push-changed-lint.mjs'
import {
  CONFIG,
  createGitFixture,
  DEBUGGER,
  GIT_TEST_TIMEOUT_MS,
  LENIENT,
  REPO_ROOT
} from './main-push-git-test-fixture.mjs'
import { isEmptyPlan, oxlintVersionFromLockfile, planLint } from './main-push-plan.mjs'
import { main as plan } from './plan-main-push-lint.mjs'

const { git, commit, makeOrigin, shallowCheckout, scratchFile, cleanup } = createGitFixture()
afterAll(cleanup, GIT_TEST_TIMEOUT_MS)

const CLEAN = 'export {}\n'
const lock = (version) =>
  `importers:\n\n  .:\n    devDependencies:\n      oxlint:\n        specifier: ^${version}\n        version: ${version}(oxlint-tsgolint@7.0.2007)\n`

// Push `files` on top of `setup`, returning the push's before and after SHAs.
function push(setup, files) {
  const origin = makeOrigin()
  const before = commit(origin, setup, 'setup (#1)')
  const after = commit(origin, files, 'push (#2)')
  return { origin, before, after }
}

async function planFor({ origin, before, after }) {
  const cwd = shallowCheckout(origin, after)
  git(cwd, 'fetch', '-q', '--depth=1', 'origin', before)
  return planLint({ base: before, head: after, cwd })
}

// The workflow's two steps: plan into a file, then lint from it, with stdout and the summary captured.
async function runWorkflow({ origin, before, after }, api = async () => []) {
  const cwd = shallowCheckout(origin, after)
  const env = {
    GITHUB_EVENT_NAME: 'push',
    BEFORE_SHA: before,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_STEP_SUMMARY: scratchFile('summary.md'),
    GITHUB_OUTPUT: scratchFile('output.txt'),
    MAIN_PUSH_LINT_PLAN: scratchFile('plan.json')
  }
  const out = []
  const write = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk) => out.push(String(chunk)))
  let planExit
  let lintExit = null
  try {
    planExit = await plan({ env, root: cwd })
    const gated = existsSync(env.GITHUB_OUTPUT) && readFileSync(env.GITHUB_OUTPUT, 'utf8')
    if (gated === 'lint=true\n') {
      lintExit = await lint({ env, root: cwd, api, invocationRoot: REPO_ROOT })
    }
  } finally {
    write.mockRestore()
  }
  return {
    planExit,
    lintExit,
    output: existsSync(env.GITHUB_OUTPUT) ? readFileSync(env.GITHUB_OUTPUT, 'utf8') : '',
    log: out.join(''),
    summary: existsSync(env.GITHUB_STEP_SUMMARY)
      ? readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')
      : ''
  }
}

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
      `newer.ts: not changed in this push; linted because .oxlintrc.json changed (.oxlintrc.json changed by commit ${pushed.after.slice(0, 10)} by @cfg (no merged PR into main))`
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
      files: ['a.ts'],
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
    expect((await runWorkflow(pushed)).lintExit).toBe(1)
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
    expect((await runWorkflow(chain)).lintExit).toBe(1)
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
    expect((await runWorkflow(pushed)).lintExit).toBe(1)
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
    expect(broken.log).toMatch(/^::error title=Main-push lint::Cannot fetch the push base f+ /m)
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
    let exit
    try {
      exit = await lint({
        env: { GITHUB_EVENT_NAME: 'push', BEFORE_SHA: before, HEAD_SHA: after },
        root: cwd,
        invocationRoot: REPO_ROOT
      })
    } finally {
      write.mockRestore()
    }
    expect(exit).toBe(1)
    expect(out.join('')).toContain('the path is not valid UTF-8')
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

  describe('matches the pinned oxlint discovery', () => {
    it('lints a subtree when a commented .oxlintrc.jsonc tightens it', async () => {
      const jsonc = '// stricter here\n{\n  /* inline */ "rules": { "no-debugger": "error" },\n}\n'
      const pushed = push(
        { '.oxlintrc.json': LENIENT, 'sub/x.ts': DEBUGGER, 'top.ts': DEBUGGER },
        { 'sub/.oxlintrc.jsonc': jsonc }
      )
      expect(await planFor(pushed)).toMatchObject({ files: [], dirs: ['sub'] })
      const run = await runWorkflow(pushed)
      expect(run.lintExit).toBe(1)
      expect(run.log).toContain('::error file=sub/x.ts,')
      expect(run.log).not.toContain('file=top.ts')
    })

    it('follows a commented extends chain to a changed leaf', async () => {
      const pushed = push(
        {
          '.oxlintrc.json': LENIENT,
          'm/.oxlintrc.json': '{ // inherits\n "extends": ["../base.jsonc"] }\n',
          'base.jsonc': '/* shared */ { "extends": ["./rules.json"], }\n',
          'rules.json': LENIENT,
          'm/x.ts': DEBUGGER
        },
        { 'rules.json': CONFIG }
      )
      expect(await planFor(pushed)).toMatchObject({
        dirs: ['m'],
        policies: [
          {
            dir: 'm',
            paths: ['rules.json'],
            why: 'm/.oxlintrc.json depends on rules.json, which changed'
          }
        ]
      })
      expect((await runWorkflow(pushed)).lintExit).toBe(1)
    })

    it('treats a script config as changed on every push, and oxlint runs it', async () => {
      const script = 'export default { rules: { "no-debugger": "error" } }\n'
      const added = push(
        { '.oxlintrc.json': LENIENT, 't/x.ts': DEBUGGER },
        { 't/oxlint.config.ts': script }
      )
      expect(await planFor(added)).toMatchObject({
        dirs: ['t'],
        policies: [{ why: 't/oxlint.config.ts was added' }]
      })
      const addedRun = await runWorkflow(added)
      expect(addedRun.lintExit).toBe(1)
      expect(addedRun.log).toContain('::error file=t/x.ts,')
      // Its imports cannot be read, so even a docs-only push walks its scope.
      const docs = push(
        { '.oxlintrc.json': LENIENT, 't/oxlint.config.mts': script, 't/x.ts': CLEAN },
        { 'README.md': '#\n' }
      )
      expect(await planFor(docs)).toMatchObject({
        dirs: ['t'],
        policies: [
          {
            paths: [],
            why: 't/oxlint.config.mts is a script config whose inputs cannot be read, so its scope is linted on every push'
          }
        ]
      })
    })

    it('follows a symlinked config to its changed target', async () => {
      const origin = makeOrigin()
      const before = commit(
        origin,
        { '.oxlintrc.json': LENIENT, 'shared.json': LENIENT, 'd/x.ts': DEBUGGER },
        'setup'
      )
      symlinkSync('../shared.json', join(origin, 'd/.oxlintrc.json'))
      const linked = commit(origin, {}, 'link')
      const after = commit(origin, { 'shared.json': CONFIG }, 'tighten shared')
      expect(await planFor({ origin, before: linked, after })).toMatchObject({
        dirs: ['d'],
        policies: [
          { paths: ['shared.json'], why: 'd/.oxlintrc.json extends shared.json, which changed' }
        ]
      })
      expect((await runWorkflow({ origin, before: linked, after })).lintExit).toBe(1)
      expect(before).not.toBe(linked)
    })

    it('lints both scopes when a nested override moves', async () => {
      const pushed = push(
        {
          '.oxlintrc.json': CONFIG,
          'sub/.oxlintrc.json': LENIENT,
          'sub/x.ts': DEBUGGER,
          'sub/inner/y.ts': CLEAN
        },
        { 'sub/.oxlintrc.json': null, 'sub/inner/.oxlintrc.json': LENIENT }
      )
      expect(await planFor(pushed)).toMatchObject({ dirs: ['sub'] })
      const run = await runWorkflow(pushed)
      expect(run.lintExit).toBe(1)
      expect(run.log).toContain('::error file=sub/x.ts,')
    })

    it('lints the scope of a config it cannot read, and keeps unrelated JSON edits out of scope', async () => {
      const unreadable = push(
        {
          '.oxlintrc.json': CONFIG,
          'u/.oxlintrc.json': '{ "rules": ',
          'u/x.ts': CLEAN,
          'data.json': '{}'
        },
        { 'data.json': '{"a":1}' }
      )
      expect(await planFor(unreadable)).toMatchObject({
        dirs: ['u'],
        policies: [
          {
            why: 'u/.oxlintrc.json does not parse as JSON with comments, so its scope is linted on every push'
          }
        ]
      })
      const outside = push(
        {
          '.oxlintrc.json': CONFIG,
          'o/.oxlintrc.json': '{ "extends": ["../../elsewhere.json"] }',
          'data.json': '{}'
        },
        { 'data.json': '{"a":1}' }
      )
      expect(await planFor(outside)).toMatchObject({ dirs: ['o'] })
      const control = push(
        { '.oxlintrc.json': CONFIG, 'data.json': '{}', 'a.ts': CLEAN },
        { 'data.json': '{"a":1}' }
      )
      expect(await planFor(control)).toMatchObject({ files: [], dirs: [], policies: [] })
    })
  })

  describe('keeps touched files the policy walk would skip', () => {
    // As in Orca, where release/ is Git-ignored but files under worker/release/ are tracked.
    const setup = (config) => ({
      '.gitignore': 'release/\n',
      '.oxlintrc.json': config,
      'w/release/kept.ts': CLEAN,
      'w/release/untouched.ts': DEBUGGER,
      'old.ts': DEBUGGER,
      'w.ts': CLEAN
    })
    const errorsFor = (log, file) =>
      log.split('\n').filter((line) => line.startsWith(`::error file=${file},`))

    it('lints a touched Git-ignored file on a source-only push', async () => {
      const pushed = push(setup(CONFIG), { 'w/release/kept.ts': DEBUGGER })
      expect(await planFor(pushed)).toMatchObject({ files: ['w/release/kept.ts'], dirs: [] })
      const run = await runWorkflow(pushed)
      expect(run.lintExit).toBe(1)
      expect(errorsFor(run.log, 'w/release/kept.ts')).toHaveLength(1)
    })

    it('names it next to the root walk on a mixed push, without duplicates or a walk of the ignored directory', async () => {
      const pushed = push(setup(LENIENT), {
        '.oxlintrc.json': CONFIG,
        'w/release/kept.ts': DEBUGGER,
        'w.ts': DEBUGGER
      })
      expect(await planFor(pushed)).toMatchObject({
        touched: ['.oxlintrc.json', 'w.ts', 'w/release/kept.ts'].filter((file) =>
          file.endsWith('.ts')
        ),
        files: ['w/release/kept.ts'],
        dirs: ['.']
      })
      const run = await runWorkflow(pushed)
      expect(run.lintExit).toBe(1)
      expect(errorsFor(run.log, 'w/release/kept.ts')).toHaveLength(1)
      expect(errorsFor(run.log, 'w.ts')).toHaveLength(1)
      expect(errorsFor(run.log, 'old.ts')).toHaveLength(1)
      // The untouched ignored file stays out, as in the PR Lint step's own walk.
      expect(errorsFor(run.log, 'w/release/untouched.ts')).toHaveLength(0)
      // old.ts and w.ts walked, kept.ts named: three files, none counted twice.
      expect(run.log).toContain('oxlint reported linting 3 file(s)')
    })
  })

  it('names every governing policy change for an untouched failure, and each changed input of one config', async () => {
    const pushed = push(
      {
        '.oxlintrc.json': LENIENT,
        'mobile/.oxlintrc.json': JSON.stringify({
          extends: ['../.oxlintrc.json', '../extra.json']
        }),
        'extra.json': '{}',
        'mobile/x.ts': DEBUGGER
      },
      {
        '.oxlintrc.json': CONFIG,
        'extra.json': JSON.stringify({ rules: {} }),
        'mobile/.oxlintrc.json': JSON.stringify({
          extends: ['../.oxlintrc.json', '../extra.json'],
          ignorePatterns: []
        })
      }
    )
    const plan = await planFor(pushed)
    expect(plan.policies).toEqual([
      { dir: '.', paths: ['.oxlintrc.json'], why: '.oxlintrc.json changed' },
      { dir: 'mobile', paths: ['mobile/.oxlintrc.json'], why: 'mobile/.oxlintrc.json changed' },
      {
        dir: 'mobile',
        paths: ['.oxlintrc.json', 'extra.json'],
        why: 'mobile/.oxlintrc.json extends .oxlintrc.json, extra.json, which changed'
      }
    ])
    const run = await runWorkflow(pushed)
    const line = run.log
      .split('\n')
      .find((text) => text.startsWith('mobile/x.ts: not changed in this push'))
    expect(line).toContain('mobile/.oxlintrc.json changed (mobile/.oxlintrc.json changed by')
    expect(line).toContain(
      'mobile/.oxlintrc.json extends .oxlintrc.json, extra.json, which changed (.oxlintrc.json changed by'
    )
    expect(line).toContain('; extra.json changed by')
    expect(line).toContain('; .oxlintrc.json changed (.oxlintrc.json changed by')
  })
})
