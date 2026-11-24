// Pin that a main push reads lint policy the way the pinned oxlint 1.94 does (config names, comments, extends,
// symlinks, unreadable inputs), and keeps every touched file covered on a policy walk. Real Git and real oxlint.
import { symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CLEAN,
  CONFIG,
  DEBUGGER,
  GIT_TEST_TIMEOUT_MS,
  LENIENT
} from './main-push-git-test-fixture.mjs'
import { createWorkflowFixture } from './main-push-workflow-test-fixture.mjs'

const { commit, makeOrigin, scratchFile, cleanup, push, planFor, runWorkflow } =
  createWorkflowFixture()
afterAll(cleanup, GIT_TEST_TIMEOUT_MS)

// The run must fail on the rule itself, on the intended file: a config that fails to load also exits 1.
async function expectDebuggerError(pushed, file) {
  const run = await runWorkflow(pushed)
  expect(run.lintExit).toBe(1)
  expect(run.log).toContain(`::error file=${file},line=1,col=1,title=eslint(no-debugger)::`)
}

describe('main-push lint policy', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
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
      await expectDebuggerError(pushed, 'm/x.ts')
    })

    it('treats a script config as changed on every push, and oxlint runs it', async () => {
      const script = 'export default { rules: { "no-debugger": "error" } }\n'
      const added = push(
        { '.oxlintrc.json': LENIENT, 't/x.ts': DEBUGGER },
        { 't/oxlint.config.ts': script }
      )
      expect(await planFor(added)).toMatchObject({
        dirs: ['t'],
        // Directly edited, and still unreadable: both are said.
        policies: [
          {
            why: 't/oxlint.config.ts was added; 1 of its inputs cannot be read',
            unreadable: ['t/oxlint.config.ts is a script config whose inputs cannot be read']
          }
        ]
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

    // Windows checkouts may not create symlinks (core.symlinks=false), and oxlint would then see a plain file.
    it.skipIf(process.platform === 'win32')(
      'follows a symlinked config to its changed target',
      async () => {
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
        await expectDebuggerError({ origin, before: linked, after }, 'd/x.ts')
        expect(before).not.toBe(linked)
      }
    )

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
        files: ['w.ts', 'w/release/kept.ts'],
        overlap: ['w.ts', 'w/release/kept.ts'],
        dirs: ['.']
      })
      const run = await runWorkflow(pushed)
      expect(run.lintExit).toBe(1)
      expect(errorsFor(run.log, 'w/release/kept.ts')).toHaveLength(1)
      expect(errorsFor(run.log, 'w.ts')).toHaveLength(1)
      expect(errorsFor(run.log, 'old.ts')).toHaveLength(1)
      // The untouched ignored file stays out, as in the PR Lint step's own walk.
      expect(errorsFor(run.log, 'w/release/untouched.ts')).toHaveLength(0)
      // Walked: old.ts and w.ts; named: w.ts and kept.ts. w.ts reached oxlint twice, so the count says so.
      expect(run.log).toContain(
        'oxlint reported linting 4 file(s); 2 changed candidate file(s) (up to 2 touched file(s) named inside a walked directory may be counted twice).'
      )
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
      { dir: '.', paths: ['.oxlintrc.json'], unreadable: [], why: '.oxlintrc.json changed' },
      {
        dir: 'mobile',
        paths: ['mobile/.oxlintrc.json'],
        unreadable: [],
        why: 'mobile/.oxlintrc.json changed'
      },
      {
        dir: 'mobile',
        paths: ['.oxlintrc.json', 'extra.json'],
        unreadable: [],
        why: 'mobile/.oxlintrc.json extends .oxlintrc.json, extra.json, which changed'
      }
    ])
    const run = await runWorkflow(pushed)
    const line = run.log
      .split('\n')
      .find((text) => text.startsWith('mobile/x.ts: not changed in this push'))
    expect(line).toContain('linted because 3 lint policy change(s) cover it; 3 shown: ')
    expect(line).toContain(
      'mobile/.oxlintrc.json changed [1 changed input(s)] (mobile/.oxlintrc.json: '
    )
    expect(line).toContain(
      'mobile/.oxlintrc.json extends .oxlintrc.json, extra.json, which changed [2 changed input(s)] (.oxlintrc.json: '
    )
    expect(line).toContain('; .oxlintrc.json changed [1 changed input(s)] (.oxlintrc.json: ')
  })

  // POSIX allows a backslash in a name; oxlint 1.94 reports it as a slash.
  describe.skipIf(process.platform === 'win32')(
    'maps a reported path back to its tracked file',
    () => {
      it('restores a backslash oxlint printed as a slash', async () => {
        const run = await runWorkflow(push({ '.oxlintrc.json': CONFIG }, { 'a\\b.ts': DEBUGGER }))
        expect(run.lintExit).toBe(1)
        expect(run.log).toContain('::error file=a\\b.ts,line=1,col=1,')
        expect(run.log).toMatch(/^a\\\\b\.ts: changed in this push by /m)
      })

      it('drops the location and attribution when the reported path could be either file', async () => {
        const run = await runWorkflow(
          push({ '.oxlintrc.json': CONFIG }, { 'a\\b.ts': DEBUGGER, 'a/b.ts': CLEAN })
        )
        expect(run.lintExit).toBe(1)
        expect(run.log).toContain(
          '::error title=eslint(no-debugger)::[path uncertain: a/b.ts or a\\b.ts] oxlint reported a/b.ts: `debugger` statement is not allowed'
        )
        expect(run.log).not.toContain('::error file=')
        expect(run.log).toMatch(
          /^a\/b\.ts: not attributed: oxlint reported this path, which could be any of a\/b\.ts, a\\\\b\.ts$/m
        )
      })
    }
  )

  // MP-C4-01: a symlinked config is read by the exact bytes of its target, and its extends resolve from where
  // oxlint opens it (the link), not where the link stores it.
  describe.skipIf(process.platform === 'win32')('follows linked policy exactly', () => {
    function linkedOrigin(files, link, target) {
      const origin = makeOrigin()
      commit(origin, files, 'setup')
      symlinkSync(target, join(origin, link))
      return { origin, before: commit(origin, {}, 'link') }
    }

    it('follows a link target with a trailing space, not the trimmed-name decoy', async () => {
      const { origin, before } = linkedOrigin(
        {
          '.oxlintrc.json': LENIENT,
          'shared.json': LENIENT,
          'shared.json ': LENIENT,
          'd/x.ts': DEBUGGER
        },
        'd/.oxlintrc.json',
        '../shared.json '
      )
      const after = commit(origin, { 'shared.json ': CONFIG }, 'tighten the linked target only')
      expect(await planFor({ origin, before, after })).toMatchObject({
        dirs: ['d'],
        policies: [{ paths: ['shared.json '] }]
      })
      await expectDebuggerError({ origin, before, after }, 'd/x.ts')
    })

    it('follows a link through a symlinked directory to the file it reads', async () => {
      const origin = makeOrigin()
      commit(
        origin,
        { '.oxlintrc.json': LENIENT, 'store/rules.json': LENIENT, 'm/x.ts': DEBUGGER },
        'setup'
      )
      symlinkSync('store', join(origin, 'alias'))
      symlinkSync('../alias/rules.json', join(origin, 'm/.oxlintrc.json'))
      const before = commit(origin, {}, 'links')
      const after = commit(origin, { 'store/rules.json': CONFIG }, 'tighten the stored rules')
      expect(await planFor({ origin, before, after })).toMatchObject({
        dirs: ['m'],
        policies: [{ paths: ['store/rules.json'] }]
      })
      await expectDebuggerError({ origin, before, after }, 'm/x.ts')
    })

    // alias -> step/.. where step -> real/child: the file system lands in real/, not the root. `.` and empty
    // segments do not change that.
    it.each(['step/..', 'step/./..', 'step//..'])(
      'treats a link to %s as unreadable, so its scope is linted',
      async (aliasTarget) => {
        const origin = makeOrigin()
        commit(
          origin,
          {
            '.oxlintrc.json': LENIENT,
            'rules.json': LENIENT,
            'real/rules.json': LENIENT,
            'real/child/keep.txt': 'x',
            'm/x.ts': DEBUGGER
          },
          'setup'
        )
        symlinkSync('real/child', join(origin, 'step'))
        symlinkSync(aliasTarget, join(origin, 'alias'))
        symlinkSync('../alias/rules.json', join(origin, 'm/.oxlintrc.json'))
        const before = commit(origin, {}, 'links')
        const after = commit(origin, { 'real/rules.json': CONFIG }, 'tighten the real rules')
        expect(await planFor({ origin, before, after })).toMatchObject({
          dirs: ['m'],
          policies: [
            {
              paths: [],
              why: "alias points through a directory name and then '..', so its scope is linted on every push"
            }
          ]
        })
        await expectDebuggerError({ origin, before, after }, 'm/x.ts')
      }
    )

    it('resolves a linked config’s extends from the link, and ignores the stored copy’s neighbour', async () => {
      const files = {
        '.oxlintrc.json': LENIENT,
        'store/cfg.json': JSON.stringify({ extends: ['./leaf.json'] }),
        'store/leaf.json': LENIENT,
        'm/leaf.json': LENIENT,
        'm/x.ts': DEBUGGER
      }
      const logical = linkedOrigin(files, 'm/.oxlintrc.json', '../store/cfg.json')
      const after = commit(logical.origin, { 'm/leaf.json': CONFIG }, 'tighten the logical leaf')
      expect(await planFor({ ...logical, after })).toMatchObject({
        dirs: ['m'],
        policies: [{ paths: ['m/leaf.json'] }]
      })
      await expectDebuggerError({ ...logical, after }, 'm/x.ts')
      // oxlint never reads store/leaf.json for m/, so tightening it changes nothing to lint there.
      const storage = linkedOrigin(files, 'm/.oxlintrc.json', '../store/cfg.json')
      const storageAfter = commit(
        storage.origin,
        { 'store/leaf.json': CONFIG },
        'tighten the storage leaf'
      )
      expect(await planFor({ ...storage, after: storageAfter })).toMatchObject({
        dirs: [],
        files: []
      })
      expect((await runWorkflow({ ...storage, after: storageAfter })).lintExit).toBe(null)
    })
  })

  it('reads hash comments like oxlint, and treats JS plugins as unreadable', async () => {
    const hashed = push(
      {
        '.oxlintrc.json': LENIENT,
        'base.json': LENIENT,
        'h/.oxlintrc.json': '# note\n{ "extends": ["../base.json"] }\n'
      },
      { 'README.md': '#\n' }
    )
    // Readable, so a docs-only push has nothing to lint.
    expect(await planFor(hashed)).toMatchObject({ dirs: [], files: [] })
    const plugins = push(
      {
        '.oxlintrc.json': LENIENT,
        'p/.oxlintrc.json': JSON.stringify({ jsPlugins: ['./rule.mjs'] })
      },
      { 'README.md': '#\n' }
    )
    expect(await planFor(plugins)).toMatchObject({
      dirs: ['p'],
      policies: [
        {
          paths: [],
          why: 'p/.oxlintrc.json loads JS plugins, whose imports cannot be followed, so its scope is linted on every push'
        }
      ]
    })
    // JS plugins declared only in an override count too; an empty list does not.
    const overridePlugins = (plugins) =>
      JSON.stringify({ overrides: [{ files: ['*.ts'], jsPlugins: plugins }] })
    const inOverride = push(
      { '.oxlintrc.json': LENIENT, 'o/.oxlintrc.json': overridePlugins(['./rule.mjs']) },
      { 'README.md': '#\n' }
    )
    expect(await planFor(inOverride)).toMatchObject({ dirs: ['o'] })
    const emptyOverride = push(
      { '.oxlintrc.json': LENIENT, 'o/.oxlintrc.json': overridePlugins([]) },
      { 'README.md': '#\n' }
    )
    expect(await planFor(emptyOverride)).toMatchObject({ dirs: [], files: [] })
    // A known change and an unreadable input on the same config: both are named.
    const mixed = push(
      {
        '.oxlintrc.json': LENIENT,
        'base.json': LENIENT,
        'k/.oxlintrc.json': JSON.stringify({ extends: ['../base.json'], jsPlugins: ['./rule.mjs'] })
      },
      { 'base.json': CONFIG }
    )
    expect(await planFor(mixed)).toMatchObject({
      dirs: ['k'],
      policies: [
        {
          paths: ['base.json'],
          unreadable: ['k/.oxlintrc.json loads JS plugins, whose imports cannot be followed'],
          why: 'k/.oxlintrc.json extends base.json, which changed; 1 of its inputs cannot be read'
        }
      ]
    })
  })

  // MP-C4-02/03: a touched file stays named even where oxlint's walk would skip it.
  describe('keeps every touched file named on a policy walk', () => {
    const base = { 'e/.eslintignore': 'gen/\n', 'old.ts': DEBUGGER }
    const errorsFor = (log, file) =>
      log.split('\n').filter((line) => line.startsWith(`::error file=${file},`))

    it('explicit only: a source push lints a file a nested .eslintignore hides from walks', async () => {
      const run = await runWorkflow(
        push({ ...base, '.oxlintrc.json': CONFIG, 'e/gen/x.ts': CLEAN }, { 'e/gen/x.ts': DEBUGGER })
      )
      expect(run.lintExit).toBe(1)
      expect(errorsFor(run.log, 'e/gen/x.ts')).toHaveLength(1)
    })

    it('walk only: a policy push does not lint an untouched file the nested .eslintignore hides', async () => {
      const run = await runWorkflow(
        push(
          { ...base, '.oxlintrc.json': LENIENT, 'e/gen/x.ts': DEBUGGER },
          { '.oxlintrc.json': CONFIG }
        )
      )
      expect(run.lintExit).toBe(1)
      expect(errorsFor(run.log, 'old.ts')).toHaveLength(1)
      expect(errorsFor(run.log, 'e/gen/x.ts')).toHaveLength(0)
    })

    it('mixed: a policy push still lints that touched file, once', async () => {
      const pushed = push(
        { ...base, '.oxlintrc.json': LENIENT, 'e/gen/x.ts': CLEAN },
        { '.oxlintrc.json': CONFIG, 'e/gen/x.ts': DEBUGGER }
      )
      expect(await planFor(pushed)).toMatchObject({ files: ['e/gen/x.ts'], dirs: ['.'] })
      const run = await runWorkflow(pushed)
      expect(run.lintExit).toBe(1)
      expect(errorsFor(run.log, 'e/gen/x.ts')).toHaveLength(1)
      expect(errorsFor(run.log, 'old.ts')).toHaveLength(1)
    })

    it.skipIf(process.platform === 'win32')(
      'passes a colon-prefixed name as a literal path, and ignores global Git excludes',
      async () => {
        const excludes = scratchFile('excludes')
        writeFileSync(excludes, 'w.ts\n')
        const globalConfig = scratchFile('gitconfig')
        writeFileSync(globalConfig, `[core]\n\texcludesFile = ${excludes}\n`)
        const previous = process.env.GIT_CONFIG_GLOBAL
        process.env.GIT_CONFIG_GLOBAL = globalConfig
        try {
          const pushed = push(
            { '.oxlintrc.json': LENIENT, 'w.ts': CLEAN },
            { '.oxlintrc.json': CONFIG, ':(top)x.ts': DEBUGGER, 'w.ts': DEBUGGER }
          )
          expect(await planFor(pushed)).toMatchObject({
            files: [':(top)x.ts', 'w.ts'],
            dirs: ['.']
          })
          const run = await runWorkflow(pushed)
          expect(run.lintExit).toBe(1)
          // Annotation properties escape ':' as %3A.
          expect(errorsFor(run.log, '%3A(top)x.ts')).toHaveLength(1)
          expect(errorsFor(run.log, 'w.ts')).toHaveLength(1)
          expect(run.log).toContain('may be counted twice')
        } finally {
          if (previous === undefined) {
            delete process.env.GIT_CONFIG_GLOBAL
          } else {
            process.env.GIT_CONFIG_GLOBAL = previous
          }
        }
      }
    )
  })

  it.skipIf(process.platform === 'win32')(
    'keeps both errors when two files print the same path, and marks the location uncertain',
    async () => {
      const run = await runWorkflow(
        push({ '.oxlintrc.json': CONFIG }, { 'a\\b.ts': DEBUGGER, 'a/b.ts': DEBUGGER })
      )
      expect(run.lintExit).toBe(1)
      const lines = run.log
        .split('\n')
        .filter((line) => line.startsWith('[path uncertain: a/b.ts or a\\\\b.ts] a/b.ts:1:1'))
      expect(lines).toHaveLength(2)
    }
  )
})
