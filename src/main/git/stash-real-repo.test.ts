import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyStash, clearStashes, dropStash, listStashes, popStash, stashChanges } from './stash'

// Why: stash's index/untracked/conflict semantics are too subtle to fake — these
// run against the real binary alongside the mocked-argv tests in stash.test.ts.

const tempRoots: string[] = []

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'orca-stash-'))
  tempRoots.push(repo)
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  }
  git(['init', '-q'])
  // Why: `git init -b` is Git 2.28+, above the project's 2.25 baseline, but the
  // subject assertions below need a deterministic branch name — symbolic-ref
  // sets it on every supported version.
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test User'])
  await writeFile(path.join(repo, 'tracked.txt'), 'base\n')
  git(['add', 'tracked.txt'])
  git(['commit', '-qm', 'init: base'])
  return repo
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' })
}

async function read(repo: string, file: string): Promise<string> {
  return readFile(path.join(repo, file), 'utf-8')
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('stash round-trip against a real repo', () => {
  it('stashes tracked changes, restores a clean tree, then pops them back', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'tracked.txt'), 'edited\n')

    expect(await stashChanges(repo)).toEqual({ success: true, stashed: true })
    expect(await read(repo, 'tracked.txt')).toBe('base\n')

    const entries = await listStashes(repo)
    expect(entries).toHaveLength(1)
    expect(entries[0].ref).toBe('stash@{0}')
    expect(entries[0].subject).toContain('WIP on main')
    expect(entries[0].commitOid).toMatch(/^[0-9a-f]{40}$/)
    expect(entries[0].createdAtSeconds).toBeGreaterThan(0)

    expect(await popStash(repo, null)).toEqual({ success: true })
    expect(await read(repo, 'tracked.txt')).toBe('edited\n')
    expect(await listStashes(repo)).toEqual([])
  })

  it('reports nothing to stash on a clean tree without creating an entry', async () => {
    const repo = await createRepo()

    expect(await stashChanges(repo)).toEqual({ success: true, stashed: false })
    expect(await listStashes(repo)).toEqual([])
  })

  it('leaves untracked files alone unless includeUntracked is set', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'tracked.txt'), 'edited\n')
    await writeFile(path.join(repo, 'fresh.txt'), 'new\n')

    await stashChanges(repo)
    expect(existsSync(path.join(repo, 'fresh.txt'))).toBe(true)

    await stashChanges(repo, { includeUntracked: true })
    expect(existsSync(path.join(repo, 'fresh.txt'))).toBe(false)

    await popStash(repo, null)
    expect(existsSync(path.join(repo, 'fresh.txt'))).toBe(true)
  })

  it('records a custom message as the stash subject', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'tracked.txt'), 'edited\n')

    await stashChanges(repo, { message: 'parked: half a refactor' })

    expect((await listStashes(repo))[0].subject).toContain('parked: half a refactor')
  })

  it('stores a dash-prefixed message verbatim instead of parsing it as a flag', async () => {
    // Why: args are passed as an array and `-m` consumes the next token, so this
    // needs no sanitizing — this test is what keeps that assumption honest.
    const repo = await createRepo()
    await writeFile(path.join(repo, 'tracked.txt'), 'edited\n')

    expect(await stashChanges(repo, { message: '--all' })).toEqual({
      success: true,
      stashed: true
    })

    expect((await listStashes(repo))[0].subject).toBe('On main: --all')
    expect(await read(repo, 'tracked.txt')).toBe('base\n')
  })

  it('keeps the entry on apply and removes it on pop', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'tracked.txt'), 'edited\n')
    await stashChanges(repo)

    expect(await applyStash(repo, 'stash@{0}')).toEqual({ success: true })
    expect(await listStashes(repo)).toHaveLength(1)

    // Why: apply left the tree dirty, so reset before popping the same entry.
    git(repo, ['checkout', '--', 'tracked.txt'])
    expect(await popStash(repo, 'stash@{0}')).toEqual({ success: true })
    expect(await listStashes(repo)).toEqual([])
  })

  it('targets the requested entry, not just the newest', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'tracked.txt'), 'first\n')
    await stashChanges(repo, { message: 'first' })
    await writeFile(path.join(repo, 'tracked.txt'), 'second\n')
    await stashChanges(repo, { message: 'second' })

    // stash@{1} is the older "first" entry.
    await popStash(repo, 'stash@{1}')

    expect(await read(repo, 'tracked.txt')).toBe('first\n')
    expect((await listStashes(repo))[0].subject).toContain('second')
  })

  it('drops one entry and clears the rest', async () => {
    const repo = await createRepo()
    for (const body of ['a', 'b', 'c']) {
      await writeFile(path.join(repo, 'tracked.txt'), `${body}\n`)
      await stashChanges(repo, { message: body })
    }
    expect(await listStashes(repo)).toHaveLength(3)

    await dropStash(repo, 'stash@{1}')
    const remaining = await listStashes(repo)
    expect(remaining).toHaveLength(2)
    expect(remaining.map((entry) => entry.subject.replace(/^On main: /, ''))).toEqual(['c', 'a'])

    await clearStashes(repo)
    expect(await listStashes(repo)).toEqual([])
  })

  it('keeps the stash entry when pop hits a conflict', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'tracked.txt'), 'stashed side\n')
    await stashChanges(repo)
    // Commit a competing change so restoring the stash cannot merge cleanly.
    await writeFile(path.join(repo, 'tracked.txt'), 'committed side\n')
    git(repo, ['commit', '-aqm', 'conflict: competing edit'])

    const result = await popStash(repo, 'stash@{0}')

    expect(result.success).toBe(false)
    expect(result.conflicted).toBe(true)
    // Why: this is the contract the UI depends on — the user's only copy survives.
    expect(await listStashes(repo)).toHaveLength(1)
    expect(await read(repo, 'tracked.txt')).toContain('<<<<<<<')
  })

  it('refuses a pop whose entry shifted after the picker read it', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'tracked.txt'), 'target\n')
    await stashChanges(repo, { message: 'target' })
    const picked = (await listStashes(repo))[0]

    // An agent stashes in the same worktree, pushing "target" to stash@{1}.
    await writeFile(path.join(repo, 'tracked.txt'), 'agent work\n')
    await stashChanges(repo, { message: 'agent' })

    await expect(popStash(repo, picked.ref, picked.commitOid)).rejects.toThrow('stash_entry_moved')
    expect(await listStashes(repo)).toHaveLength(2)

    // The same entry at its new index still applies.
    expect(await popStash(repo, 'stash@{1}', picked.commitOid)).toEqual({ success: true })
    expect(await read(repo, 'tracked.txt')).toBe('target\n')
  })

  it('refuses a drop whose entry already vanished', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'tracked.txt'), 'edited\n')
    await stashChanges(repo)
    const picked = (await listStashes(repo))[0]
    await clearStashes(repo)

    await expect(dropStash(repo, picked.ref, picked.commitOid)).rejects.toThrow('stash_entry_moved')
  })

  it('stashes on a detached HEAD', async () => {
    const repo = await createRepo()
    git(repo, ['checkout', '-q', '--detach'])
    await writeFile(path.join(repo, 'tracked.txt'), 'detached edit\n')

    expect(await stashChanges(repo)).toEqual({ success: true, stashed: true })
    expect((await listStashes(repo))[0].subject).toContain('(no branch)')

    expect(await popStash(repo, null)).toEqual({ success: true })
    expect(await read(repo, 'tracked.txt')).toBe('detached edit\n')
  })

  it('parses subjects that contain colons', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'tracked.txt'), 'edited\n')
    await stashChanges(repo, { message: 'fix: parse a:b:c' })

    expect((await listStashes(repo))[0].subject).toBe('On main: fix: parse a:b:c')
  })

  it('reports git refusing to stash before the first commit', async () => {
    // Why: the UI translates this into "make an initial commit first", so the
    // wording it keys off has to keep coming back from git.
    const repo = await mkdtemp(path.join(tmpdir(), 'orca-stash-empty-'))
    tempRoots.push(repo)
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'pipe' })
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repo, stdio: 'pipe' })
    await writeFile(path.join(repo, 'a.txt'), 'x\n')
    execFileSync('git', ['add', 'a.txt'], { cwd: repo, stdio: 'pipe' })

    const result = await stashChanges(repo)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/you do not have the initial commit yet/i)
  })

  it('surfaces a failure when there is no stash to pop', async () => {
    const repo = await createRepo()

    const result = await popStash(repo, null)

    expect(result.success).toBe(false)
    expect(result.conflicted).toBeUndefined()
    expect(result.error).toMatch(/no stash entries found/i)
  })
})
