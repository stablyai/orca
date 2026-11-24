// Pin MP-C5-01: lint policy paths that are not valid UTF-8 are kept apart from valid ones. Commits are built with
// Git plumbing, so no file system has to hold the names (the native Linux run is in the proof packet).
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CLEAN,
  CONFIG,
  createGitFixture,
  DEBUGGER,
  GIT_TEST_TIMEOUT_MS,
  LENIENT
} from './main-push-git-test-fixture.mjs'
import { planLint } from './main-push-plan.mjs'

const { git, commit, makeOrigin, shallowCheckout, scratchFile, cleanup } = createGitFixture()
afterAll(cleanup, GIT_TEST_TIMEOUT_MS)

describe('main-push lint policy bytes', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  // MP-C5-01: a name that is not valid UTF-8 must neither stand in for, nor overwrite, a valid one. Commits are
  // built with plumbing, so no file system has to hold the names; the native Linux run is in the proof packet.
  describe('keeps policy paths that are not valid UTF-8 apart', () => {
    const FF = (prefix, suffix) =>
      Buffer.concat([Buffer.from(prefix), Buffer.from([0xff]), Buffer.from(suffix)])
    function plumbCommit(origin, parent, entries) {
      const env = { ...process.env, GIT_INDEX_FILE: scratchFile('index') }
      const run = (args, input) =>
        execFileSync('git', args, { cwd: origin, env, input }).toString().trim()
      run(['read-tree', parent])
      for (const { path, content, mode = '100644', remove = false } of entries) {
        const name = Buffer.isBuffer(path) ? path : Buffer.from(path)
        if (remove) {
          run(
            ['update-index', '--index-info'],
            Buffer.concat([Buffer.from(`0 ${'0'.repeat(40)}\t`), name, Buffer.from('\n')])
          )
          continue
        }
        const blob = run(['hash-object', '-w', '--stdin'], content)
        run(
          ['update-index', '--index-info'],
          Buffer.concat([Buffer.from(`${mode} ${blob}\t`), name, Buffer.from('\n')])
        )
      }
      const tree = run(['write-tree'])
      return run(
        [
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@example.com',
          'commit-tree',
          tree,
          '-p',
          parent,
          '-m',
          'plumbed'
        ],
        ''
      )
    }
    async function planPlumbed(origin, base, head) {
      // main stays at the clean setup commit, so the clone checks out; the endpoints are fetched, not checked out.
      const cwd = shallowCheckout(origin)
      git(cwd, 'fetch', '-q', '--depth=1', 'origin', base)
      git(cwd, 'fetch', '-q', '--depth=1', 'origin', head)
      return planLint({ base, head, cwd })
    }

    it('treats a link whose stored target is not valid UTF-8 as unreadable, not as the valid decoy', async () => {
      const origin = makeOrigin()
      const clean = commit(
        origin,
        { '.oxlintrc.json': LENIENT, 'm/x.ts': DEBUGGER, 'leaf�.json': LENIENT },
        'clean'
      )
      const base = plumbCommit(origin, clean, [
        { path: FF('leaf', '.json'), content: LENIENT },
        { path: 'm/.oxlintrc.json', mode: '120000', content: FF('../leaf', '.json') }
      ])
      const head = plumbCommit(origin, base, [{ path: FF('leaf', '.json'), content: CONFIG }])
      expect(await planPlumbed(origin, base, head)).toMatchObject({
        dirs: ['m'],
        policies: [
          {
            paths: [],
            why: 'm/.oxlintrc.json points at a path that is not valid UTF-8, so its scope is linted on every push'
          }
        ]
      })
    })

    it('does not let a tree name that is not valid UTF-8 overwrite a valid one', async () => {
      const origin = makeOrigin()
      const clean = commit(
        origin,
        {
          '.oxlintrc.json': LENIENT,
          'm/x.ts': DEBUGGER,
          'm/leaf.json': LENIENT,
          'rules�.json': JSON.stringify({ extends: ['./leaf.json'] })
        },
        'clean'
      )
      const base = plumbCommit(origin, clean, [
        { path: FF('rules', '.json'), content: '{}' },
        { path: 'm/.oxlintrc.json', mode: '120000', content: Buffer.from('../rules�.json') }
      ])
      const head = plumbCommit(origin, base, [{ path: 'm/leaf.json', content: CONFIG }])
      expect(await planPlumbed(origin, base, head)).toMatchObject({
        dirs: ['m'],
        policies: [{ paths: ['m/leaf.json'] }]
      })
      // Narrow control: the same tree with an unrelated push plans nothing.
      const docs = plumbCommit(origin, base, [{ path: 'README.md', content: '#\n' }])
      expect(await planPlumbed(origin, base, docs)).toMatchObject({ dirs: [], files: [] })
    })

    it('walks the whole tree when a config sits at a path that is not valid UTF-8', async () => {
      const origin = makeOrigin()
      const clean = commit(origin, { '.oxlintrc.json': LENIENT, 'a.ts': CLEAN }, 'clean')
      const base = plumbCommit(origin, clean, [
        { path: FF('d', '/.oxlintrc.json'), content: CONFIG }
      ])
      const head = plumbCommit(origin, base, [{ path: 'README.md', content: '#\n' }])
      expect(await planPlumbed(origin, base, head)).toMatchObject({
        dirs: ['.'],
        policies: [
          { why: '1 config path(s) are not valid UTF-8, so the whole tree is linted on every push' }
        ]
      })
    })

    it('walks the whole tree when a config at a path that is not valid UTF-8 is deleted', async () => {
      const origin = makeOrigin()
      const clean = commit(origin, { '.oxlintrc.json': CONFIG, 'a.ts': CLEAN }, 'clean')
      const base = plumbCommit(origin, clean, [
        { path: FF('d', '/.oxlintrc.json'), content: LENIENT },
        { path: FF('d', '/x.ts'), content: DEBUGGER }
      ])
      const head = plumbCommit(origin, base, [{ path: FF('d', '/.oxlintrc.json'), remove: true }])
      expect(await planPlumbed(origin, base, head)).toMatchObject({
        dirs: ['.'],
        policies: [
          { why: '1 changed config path(s) are not valid UTF-8, so the whole tree is linted' }
        ]
      })
      // Control: deleting an ordinary file at such a path changes no policy.
      const sourceOnly = plumbCommit(origin, head, [{ path: FF('d', '/x.ts'), remove: true }])
      expect(await planPlumbed(origin, head, sourceOnly)).toMatchObject({ dirs: [], files: [] })
    })
  })
})
