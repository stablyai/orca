import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { detectConflictOperation } from './git-conflict-operation'
import { continueRebase } from './rebase-continue'
import { createConflictingRebaseRepo } from './rebase-real-git.test-fixture'
describe('continueRebase against real git', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    for (const path of tempPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  const createFeatureBehindConflictingMain = () => createConflictingRebaseRepo(tempPaths)

  async function stopToken(repoPath: string) {
    const inspected = await continueRebase(repoPath, 'inspect')
    expect(inspected.outcome).toBe('inspected')
    return inspected.stop
  }

  it('continues only the inspected stop, reporting a later conflict and then completion', async () => {
    const { repoPath, git, write } = createFeatureBehindConflictingMain()
    expect(() => git('rebase', 'main')).toThrow()
    await expect(continueRebase(repoPath, 'inspect')).resolves.toMatchObject({
      outcome: 'inspected',
      branch: 'feature'
    })

    write('a.txt', 'resolved a\n')
    git('add', 'a.txt')
    const first = await continueRebase(repoPath, 'continue', {
      expected: await stopToken(repoPath)
    })
    expect(first.outcome).toBe('conflicted')
    expect(git('diff', '--name-only', '--diff-filter=U')).toBe('b.txt\n')

    write('b.txt', 'resolved b\n')
    git('add', 'b.txt')
    await expect(
      continueRebase(repoPath, 'continue', { expected: first.stop })
    ).resolves.toMatchObject({ outcome: 'completed', branch: 'feature' })
    await expect(detectConflictOperation(repoPath)).resolves.toBe('unknown')
    expect(git('log', '-1', '--format=%s').trim()).toBe('feature b')
  })

  it('refuses a Continue without a token or with one from an earlier stop', async () => {
    const { repoPath, git, write } = createFeatureBehindConflictingMain()
    expect(() => git('rebase', 'main')).toThrow()
    const firstStop = await stopToken(repoPath)
    await expect(continueRebase(repoPath, 'continue')).resolves.toMatchObject({ outcome: 'stale' })

    write('a.txt', 'resolved a\n')
    git('add', 'a.txt')
    await continueRebase(repoPath, 'continue', { expected: firstStop })
    write('b.txt', 'resolved b\n')
    git('add', 'b.txt')

    // A delayed retry of the first click must not finish the second stop.
    await expect(
      continueRebase(repoPath, 'continue', { expected: firstStop })
    ).resolves.toMatchObject({ outcome: 'stale' })
    await expect(detectConflictOperation(repoPath)).resolves.toBe('rebase')
  })

  it('refuses a token from before an identical abort and restart', async () => {
    const { repoPath, git, write } = createFeatureBehindConflictingMain()
    expect(() => git('rebase', 'main')).toThrow()
    const beforeRestart = await stopToken(repoPath)
    git('rebase', '--abort')
    expect(() => git('rebase', 'main')).toThrow()
    write('a.txt', 'resolved a\n')
    git('add', 'a.txt')

    await expect(
      continueRebase(repoPath, 'continue', { expected: beforeRestart })
    ).resolves.toMatchObject({ outcome: 'stale' })
    expect(git('diff', '--name-only', '--cached')).toBe('a.txt\n')
  })

  it('treats a stop token with a missing field as stale, never equal', async () => {
    const { repoPath, git, write } = createFeatureBehindConflictingMain()
    expect(() => git('rebase', 'main')).toThrow()
    write('a.txt', 'resolved a\n')
    git('add', 'a.txt')
    const stop = await stopToken(repoPath)
    if (!stop) {
      throw new Error('expected a stop')
    }
    for (const missing of ['head', 'step', 'incarnation'] as const) {
      await expect(
        continueRebase(repoPath, 'continue', { expected: { ...stop, [missing]: null } })
      ).resolves.toMatchObject({ outcome: 'stale' })
    }
    await expect(detectConflictOperation(repoPath)).resolves.toBe('rebase')
  })

  it('keeps the rebase paused and reports git’s refusal for an unstaged resolution', async () => {
    const { repoPath, git, write } = createFeatureBehindConflictingMain()
    expect(() => git('rebase', 'main')).toThrow()
    write('a.txt', 'resolved a\n')

    const result = await continueRebase(repoPath, 'continue', {
      expected: await stopToken(repoPath)
    })
    expect(result.outcome).toBe('failed')
    expect(result.message).toBeTruthy()
    await expect(detectConflictOperation(repoPath)).resolves.toBe('rebase')
  })

  it('reports an empty step on the apply backend so Continue is withheld', async () => {
    const { repoPath, git } = createFeatureBehindConflictingMain()
    // Git 2.25's default backend refuses to continue when the resolution changes nothing.
    expect(() => git('rebase', '--apply', 'main')).toThrow()
    git('checkout', '--ours', 'a.txt')
    git('add', 'a.txt')

    await expect(
      continueRebase(repoPath, 'continue', { expected: await stopToken(repoPath) })
    ).resolves.toMatchObject({ outcome: 'empty' })
    await expect(detectConflictOperation(repoPath)).resolves.toBe('rebase')
  })

  it('treats the merge backend dropping an empty pick before the next conflict as conflicted', async () => {
    const { repoPath, git } = createFeatureBehindConflictingMain()
    expect(() => git('rebase', '--merge', 'main')).toThrow()
    git('checkout', '--ours', 'a.txt')
    git('add', 'a.txt')
    const headBefore = git('rev-parse', 'HEAD')

    // HEAD stays put because the empty pick is dropped; only the step counter shows progress.
    await expect(
      continueRebase(repoPath, 'continue', { expected: await stopToken(repoPath) })
    ).resolves.toMatchObject({ outcome: 'conflicted' })
    expect(git('rev-parse', 'HEAD')).toBe(headBefore)
  })

  it('reports a repeated Continue after completion as not rebasing, not success', async () => {
    const { repoPath, git, write } = createFeatureBehindConflictingMain()
    expect(() => git('rebase', 'main')).toThrow()
    write('a.txt', 'resolved a\n')
    git('add', 'a.txt')
    const first = await continueRebase(repoPath, 'continue', {
      expected: await stopToken(repoPath)
    })
    write('b.txt', 'resolved b\n')
    git('add', 'b.txt')
    await continueRebase(repoPath, 'continue', { expected: first.stop })

    await expect(continueRebase(repoPath, 'continue', { expected: first.stop })).resolves.toEqual({
      outcome: 'not_rebasing'
    })
  })

  it('flags an autostash that could not reapply after the rebase completes', async () => {
    const { repoPath, git, write } = createFeatureBehindConflictingMain()
    write('c.txt', 'uncommitted c\n')
    expect(() => git('rebase', '--autostash', 'main')).toThrow()
    write('a.txt', 'resolved a\n')
    git('add', 'a.txt')
    const first = await continueRebase(repoPath, 'continue', {
      expected: await stopToken(repoPath)
    })
    write('b.txt', 'resolved b\n')
    git('add', 'b.txt')

    await expect(
      continueRebase(repoPath, 'continue', { expected: first.stop })
    ).resolves.toMatchObject({ outcome: 'completed_autostash_conflict' })
    expect(git('stash', 'list')).toContain('autostash')
  })
})
