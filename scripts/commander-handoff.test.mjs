import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runProcessSync } from '@orca/process-host'

const cli = fileURLToPath(new URL('./commander-handoff.mjs', import.meta.url))

function createHandoffFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'orca-handoff-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const first = join(root, 'first')
  const second = join(root, 'second')
  const remote = join(root, 'upstream.git')
  const file = join(root, 'progress.json')
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.org',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.org',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'absent.gitconfig')
  }
  const exec = (program, cwd, ...args) => {
    const result = runProcessSync({ program, args, cwd, env })
    if (result.code !== 0) {
      throw new Error(result.stderr)
    }
    return result.stdout.trim()
  }
  const git = (cwd, ...args) => exec('git', cwd, ...args)
  const handoff = (cwd, ...args) => exec(process.execPath, cwd, cli, ...args)
  git(root, 'init', '--bare', remote)
  git(root, 'clone', remote, first)
  writeFileSync(join(first, 'code.txt'), 'committed')
  git(first, 'add', 'code.txt')
  git(first, 'commit', '-m', 'initial version')
  git(first, 'push', 'origin', 'HEAD')
  git(root, 'clone', '--no-local', remote, second)
  return { root, first, second, remote, file, git, handoff }
}

test('a fresh checkout recovers published progress and refuses divergent handoffs', (t) => {
  const { first, second, file, git, handoff } = createHandoffFixture(t)
  writeFileSync(join(first, 'code.txt'), 'unsaved code')
  writeFileSync(
    file,
    JSON.stringify({ goal: 'Publish API', next: 'Run SDK tests', checks: ['API tests passed'] })
  )
  const saved = JSON.parse(handoff(first, 'save', 'release', file))
  assert.equal(saved.dirty, true)
  assert.throws(() => handoff(second, 'restore', 'release', 'origin'))
  handoff(first, 'publish', 'release', 'origin')
  const restored = JSON.parse(handoff(second, 'restore', 'release', 'origin'))
  assert.equal(restored.matchesCheckoutCommit, true)
  assert.deepEqual(restored.progress.checks, ['API tests passed'])
  assert.equal(restored.progress.next, 'Run SDK tests')
  assert.equal(readFileSync(join(second, 'code.txt'), 'utf8'), 'committed')
  assert.equal(restored.hasTrackedEdits, false)
  writeFileSync(join(first, 'private.tmp'), 'local only')
  handoff(first, 'save', 'snapshot', file, '--include-tracked-edits')
  assert.throws(() => handoff(first, 'publish', 'snapshot', 'origin'), /history contains code/)
  handoff(first, 'publish', 'snapshot', 'origin', '--include-tracked-edits')
  const snapshot = JSON.parse(handoff(second, 'restore', 'snapshot', 'origin'))
  assert.equal(snapshot.hasTrackedEdits, true)
  assert.equal(readFileSync(join(second, 'code.txt'), 'utf8'), 'committed')
  writeFileSync(join(second, 'code.txt'), 'local work')
  assert.throws(() => handoff(second, 'apply', 'snapshot'), /Commit or stash/)
  assert.equal(readFileSync(join(second, 'code.txt'), 'utf8'), 'local work')
  git(second, 'commit', '-am', 'local work')
  assert.throws(() => handoff(second, 'apply', 'snapshot'), /Check out the handoff base/)
  git(second, 'checkout', '--detach', snapshot.commit)
  handoff(second, 'apply', 'snapshot')
  assert.equal(readFileSync(join(second, 'code.txt'), 'utf8'), 'unsaved code')
  assert.equal(git(second, 'diff', '--cached', '--name-only'), 'code.txt')
  assert.equal(existsSync(join(second, 'private.tmp')), false)
  handoff(first, 'save', 'snapshot', file)
  assert.throws(() => handoff(first, 'publish', 'snapshot', 'origin'), /history contains code/)
  writeFileSync(file, JSON.stringify({ goal: 'Publish API', next: 'Fix SDK build' }))
  handoff(first, 'save', 'release', file)
  handoff(first, 'publish', 'release', 'origin')
  writeFileSync(file, JSON.stringify({ goal: 'Publish API', next: 'Check mobile build' }))
  handoff(second, 'save', 'release', file)
  assert.throws(() => handoff(second, 'publish', 'release', 'origin'))
  assert.throws(() => handoff(second, 'restore', 'release', 'origin'), /unpublished changes/)
  assert.equal(JSON.parse(handoff(second, 'read', 'release')).progress.next, 'Check mobile build')
})

test('publishing a handoff retains an unpushed base after remote GC and excludes ignored files', (t) => {
  const { root, first, remote, file, git, handoff } = createHandoffFixture(t)
  writeFileSync(file, JSON.stringify({ goal: 'Ship', next: 'Review the latest commit' }))
  writeFileSync(join(first, '.gitignore'), '*.local\n')
  writeFileSync(join(first, 'tracked.patch'), 'a regular project file, unrelated to Orca')
  writeFileSync(join(first, 'code.txt'), 'local commit')
  git(first, 'add', '.gitignore', 'code.txt', 'tracked.patch')
  git(first, 'commit', '-m', 'work still only on this machine')
  const localBase = git(first, 'rev-parse', 'HEAD')
  writeFileSync(join(first, 'token.local'), 'machine-only secret')
  const ignoredBlob = git(first, 'hash-object', 'token.local')
  handoff(first, 'save', 'resume', file)
  handoff(first, 'publish', 'resume', 'origin')
  git(remote, 'gc', '--prune=now')
  const second = join(root, 'fresh')
  git(root, 'clone', '--no-local', '--single-branch', remote, second)
  assert.throws(() => git(second, 'cat-file', '-e', localBase))
  const resumed = JSON.parse(handoff(second, 'restore', 'resume', 'origin'))
  assert.equal(resumed.commit, localBase)
  git(second, 'checkout', '--detach', resumed.commit)
  assert.equal(readFileSync(join(second, 'code.txt'), 'utf8'), 'local commit')
  assert.equal(existsSync(join(second, 'token.local')), false)
  assert.throws(() => git(remote, 'cat-file', '-e', ignoredBlob))
})

test('publishing an older JSON-only handoff retains its original base and progress', (t) => {
  const { first, second, file, git, handoff } = createHandoffFixture(t)
  writeFileSync(join(first, 'code.txt'), 'original machine only')
  git(first, 'commit', '-am', 'unpushed work')
  const base = git(first, 'rev-parse', 'HEAD')
  writeFileSync(file, JSON.stringify({ goal: 'Finish migration', next: 'Check fixtures' }))
  handoff(first, 'save', 'legacy', file)
  const ref = 'refs/orca/handoffs/legacy'
  const legacy = git(
    first,
    'commit-tree',
    git(first, 'rev-parse', `${ref}^{tree}`),
    '-m',
    'legacy checkpoint without source parent'
  )
  git(first, 'update-ref', ref, legacy)
  assert.equal(JSON.parse(handoff(first, 'read', 'legacy')).progress.next, 'Check fixtures')
  handoff(first, 'publish', 'legacy', 'origin')
  assert.equal(JSON.parse(handoff(second, 'restore', 'legacy', 'origin')).commit, base)
  git(second, 'checkout', '--detach', base)
  assert.equal(readFileSync(join(second, 'code.txt'), 'utf8'), 'original machine only')
})
