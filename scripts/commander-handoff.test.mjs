import assert from 'node:assert/strict'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runProcess, runProcessSync } from '@orca/process-host'
import { handoffWriteRecovery, handoffIsDirty } from './commander-handoff-changes.mjs'
import { stageOnHandoffBase } from './commander-handoff-base.mjs'

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
  return { root, first, second, remote, file, git, handoff, env }
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

test('handoff patches keep context when the checkout displays zero context', (t) => {
  const { first, file, git, handoff } = createHandoffFixture(t)
  const path = join(first, 'code.txt')
  const original = 'first\nsecond\nthird\nfourth\nfifth\n'
  const modified = original.replace('third', 'changed')
  writeFileSync(path, original)
  git(first, 'commit', '-am', 'multi-line base')
  git(first, 'config', 'diff.context', '0')
  writeFileSync(file, JSON.stringify({ goal: 'Ship', next: 'Verify the change' }))
  writeFileSync(path, modified)
  handoff(first, 'save', 'context', file, '--include-tracked-edits')
  git(first, 'checkout', '--', 'code.txt')
  handoff(first, 'apply', 'context')
  assert.equal(readFileSync(path, 'utf8'), modified)
  assert.equal(git(first, 'show', ':code.txt'), modified.trimEnd())
})

test('the handoff base stays locked until staging returns on a branch and detached HEAD', async (t) => {
  const { first, git } = createHandoffFixture(t)
  const base = git(first, 'rev-parse', 'HEAD')
  const ref = git(first, 'symbolic-ref', 'HEAD')
  const worktreeIndex = join(first, git(first, 'rev-parse', '--git-path', 'index'))
  git(first, 'checkout', '-b', 'competing-checkout')
  writeFileSync(join(first, 'code.txt'), 'on the other branch')
  git(first, 'commit', '-am', 'different worktree')
  const other = git(first, 'rev-parse', 'HEAD')
  git(first, 'checkout', ref.slice('refs/heads/'.length))
  const index = `${worktreeIndex}.alternate`
  copyFileSync(worktreeIndex, index)
  const target = { cwd: first, index, worktreeIndex, expected: base }
  const moveHead = (...args) =>
    git(first, '-c', 'core.filesRefLockTimeout=0', 'update-ref', ...args)
  await stageOnHandoffBase(target, () => {
    assert.throws(() => moveHead('--no-deref', 'HEAD', other), /lock/i)
    assert.throws(() => moveHead(ref, other), /lock/i)
    assert.throws(() => git(first, 'checkout', 'competing-checkout'), /index.lock/i)
    assert.equal(git(first, 'rev-parse', 'HEAD'), base)
    assert.equal(readFileSync(join(first, 'code.txt'), 'utf8'), 'committed')
    assert.equal(git(first, 'show', ':code.txt'), 'committed')
  })
  git(first, 'checkout', '--detach', base)
  await assert.rejects(
    stageOnHandoffBase(target, () => {
      assert.throws(() => moveHead('--no-deref', 'HEAD', other), /lock/i)
      throw new Error('stage failed')
    }),
    /stage failed/
  )
  moveHead('--no-deref', 'HEAD', other)
  let staged = false
  await assert.rejects(
    stageOnHandoffBase(target, () => {
      staged = true
    }),
    /handoff base/i
  )
  assert.equal(staged, false)
})

test('large status output is drained, and an untracked file still marks a progress-only save dirty', async (t) => {
  const { root, first, file, git, handoff } = createHandoffFixture(t)
  writeFileSync(file, JSON.stringify({ goal: 'Ship', next: 'Review' }))
  assert.equal(JSON.parse(handoff(first, 'save', 'large', file)).dirty, false)
  for (let i = 0; i < 1600; i++) {
    writeFileSync(join(first, `${'x'.repeat(82)}-${i}`), '')
  }
  assert.ok(Buffer.byteLength(git(first, 'status', '--porcelain')) > 128 * 1024)
  assert.equal(JSON.parse(handoff(first, 'save', 'large', file)).dirty, true)
  await assert.rejects(handoffIsDirty({ cwd: root }), /not a git repository/i)
})

test('capturing a patch refuses conflicting staged and worktree versions and preserves the prior save', (t) => {
  const { first, file, git, handoff } = createHandoffFixture(t)
  writeFileSync(file, JSON.stringify({ goal: 'Ship', next: 'Review' }))
  const path = join(first, 'code.txt')
  const ref = 'refs/orca/handoffs/mixed'
  writeFileSync(path, 'staged version')
  git(first, 'add', 'code.txt')
  handoff(first, 'save', 'mixed', file, '--include-tracked-edits')
  const prior = git(first, 'rev-parse', ref)
  assert.match(git(first, 'show', `${ref}:tracked.patch`), /staged version/)
  writeFileSync(path, 'committed')
  assert.throws(
    () => handoff(first, 'save', 'mixed', file, '--include-tracked-edits'),
    /both staged and unstaged/
  )
  assert.equal(git(first, 'rev-parse', ref), prior)
  assert.equal(git(first, 'show', ':code.txt'), 'staged version')
  assert.equal(JSON.parse(handoff(first, 'save', 'progress', file)).dirty, true)
})

test(
  'a checkout after reading HEAD prevents publication of the stale capture',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { root, first, file, git, handoff, env } = createHandoffFixture(t)
    const progress = JSON.stringify({ goal: 'Ship', next: 'Check' })
    writeFileSync(file, progress)
    const baseBranch = git(first, 'symbolic-ref', '--short', 'HEAD')
    handoff(first, 'save', 'moving', file)
    const ref = 'refs/orca/handoffs/moving'
    const previous = git(first, 'rev-parse', ref)
    git(first, 'checkout', '-b', 'other')
    writeFileSync(join(first, 'code.txt'), 'another commit')
    git(first, 'commit', '-am', 'other revision')
    git(first, 'checkout', baseBranch)
    const fifo = join(root, 'progress-pipe')
    assert.equal(runProcessSync({ program: 'mkfifo', args: [fifo] }).code, 0)
    const saving = runProcess({
      program: process.execPath,
      cwd: first,
      args: [cli, 'save', 'moving', fifo, '--include-tracked-edits'],
      env,
      timeoutMs: 15_000
    })
    const input = await openFile(fifo, 'w')
    try {
      git(first, 'checkout', 'other')
      await input.writeFile(progress)
    } finally {
      await input.close()
    }
    const result = await saving
    assert.equal(result.code, 1)
    assert.match(result.stderr, /HEAD/)
    assert.equal(git(first, 'rev-parse', ref), previous)
  }
)

test('a failed index publication identifies affected paths and preserves unrelated changes', async (t) => {
  const { first, second, git, env } = createHandoffFixture(t)
  writeFileSync(join(first, 'new.txt'), 'new file')
  git(first, 'add', 'new.txt')
  writeFileSync(join(first, 'code.txt'), 'modified')
  const patch = Buffer.from(`${git(first, 'diff', '--binary', 'HEAD')}\n`)
  writeFileSync(join(second, 'other-tracked.txt'), 'original')
  git(second, 'add', 'other-tracked.txt')
  git(second, 'commit', '-m', 'track an unrelated file')
  const target = {
    cwd: second,
    index: join(second, '.git', 'index'),
    expected: git(second, 'rev-parse', 'HEAD')
  }
  writeFileSync(join(second, 'unrelated.tmp'), 'keep')
  await assert.rejects(
    stageOnHandoffBase(target, (index, onWriteFailure) => {
      onWriteFailure(handoffWriteRecovery(target, patch))
      const applied = runProcessSync({
        program: 'git',
        args: ['apply', '--index', '-'],
        cwd: second,
        input: patch,
        env: { ...env, GIT_INDEX_FILE: index }
      })
      assert.equal(applied.code, 0, applied.stderr)
      writeFileSync(join(second, 'other-tracked.txt'), 'concurrent edit')
      rmSync(index) // Reproduce a failure after writing files, at the final index rename.
    }),
    (error) => {
      assert.match(error.message, /restore --worktree/)
      assert.match(error.message, /"code.txt"/)
      assert.match(error.message, /New paths[^]*"new.txt"/)
      assert.doesNotMatch(error.message, /unrelated.tmp|other-tracked.txt/)
      return true
    }
  )
  assert.equal(readFileSync(join(second, 'unrelated.tmp'), 'utf8'), 'keep')
  assert.equal(readFileSync(join(second, 'other-tracked.txt'), 'utf8'), 'concurrent edit')
  assert.equal(git(second, 'diff', '--cached', '--name-only'), '')
  git(second, '--literal-pathspecs', 'restore', '--worktree', '--', 'code.txt')
  assert.equal(readFileSync(join(second, 'code.txt'), 'utf8'), 'committed')
})

test('a relative alternate index in a subdirectory captures disjoint staged and unstaged patches', (t) => {
  const { first, file, git, handoff, env } = createHandoffFixture(t)
  writeFileSync(file, JSON.stringify({ goal: 'Ship', next: 'Check' }))
  const subdir = join(first, 'subdir')
  mkdirSync(subdir)
  const alternate = join(first, '.git', 'alternate')
  copyFileSync(join(first, '.git', 'index'), alternate)
  const fromSubdir = (program, args) =>
    runProcessSync({
      program,
      args,
      cwd: subdir,
      env: { ...env, GIT_INDEX_FILE: '.git/alternate' }
    })
  writeFileSync(join(first, 'added.txt'), 'staged new file')
  const staged = fromSubdir('git', ['add', '../added.txt'])
  assert.equal(staged.code, 0, staged.stderr)
  writeFileSync(join(first, 'code.txt'), 'unstaged edit')
  const saveArgs = [cli, 'save', 'alternate', file, '--include-tracked-edits']
  const saved = fromSubdir(process.execPath, saveArgs)
  assert.equal(saved.code, 0, saved.stderr)
  const ref = 'refs/orca/handoffs/alternate'
  const prior = git(first, 'rev-parse', ref)
  writeFileSync(join(first, 'added.txt'), 'overwritten staged content')
  assert.match(fromSubdir(process.execPath, saveArgs).stderr, /both staged and unstaged/)
  assert.equal(git(first, 'rev-parse', ref), prior)
  rmSync(join(first, 'added.txt'))
  git(first, 'checkout', '--', 'code.txt')
  handoff(first, 'apply', 'alternate')
  assert.equal(git(first, 'show', ':added.txt'), 'staged new file')
  assert.equal(git(first, 'show', ':code.txt'), 'unstaged edit')
})

test(
  'recovery avoids path-specific advice when a raw Git filename is invalid UTF-8',
  { skip: process.platform === 'win32' },
  (t) => {
    const { first, second, git } = createHandoffFixture(t)
    const raw = Buffer.concat([Buffer.from(`${first}/`), Buffer.from([0xff])])
    writeFileSync(raw, 'raw name')
    git(first, 'add', '-A')
    const patch = Buffer.from(`${git(first, 'diff', '--cached', '--binary')}\n`)
    const describe = handoffWriteRecovery(
      { cwd: second, index: join(second, '.git', 'index') },
      patch
    )
    const error = describe(new Error('index publication failed'))
    assert.match(error.message, /core.quotePath=true status/)
    assert.doesNotMatch(error.message, /restore --worktree|�/)
  }
)
