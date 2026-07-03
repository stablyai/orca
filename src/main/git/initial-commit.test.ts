import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createInitialCommit,
  createInitialCommitSerialized,
  GIT_IDENTITY_GUIDANCE_MESSAGE
} from './initial-commit'
import type { GitExec } from './repo'

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: env ?? process.env
  })
}

function makeExec(cwd: string, env?: NodeJS.ProcessEnv): GitExec {
  return async (argv) => ({ stdout: git(cwd, argv, env) })
}

function initRepo(dir: string, branch = 'main'): void {
  git(dir, ['init', '--quiet'])
  git(dir, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
}

// Why: CI git has no init.defaultBranch, so bare init lands on master there;
// pin HEAD so assertions on 'main' hold on every machine.
function initBareRepo(dir: string, extraArgs: string[] = []): void {
  git(dir, ['init', '--bare', '--quiet', ...extraArgs])
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
}

function configureIdentity(dir: string): void {
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test User'])
}

function commitCount(dir: string): number {
  return Number(git(dir, ['rev-list', '--count', 'HEAD']).trim())
}

function headBranch(dir: string): string {
  return git(dir, ['symbolic-ref', '--short', 'HEAD']).trim()
}

function headSha(dir: string): string {
  return git(dir, ['rev-parse', 'HEAD']).trim()
}

function headTreeEntries(dir: string): string {
  return git(dir, ['ls-tree', '-r', 'HEAD']).trim()
}

function makeCommitObject(dir: string, message = 'existing'): string {
  return git(dir, ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', message]).trim()
}

function getStagedNames(dir: string): string[] {
  return git(dir, ['diff', '--cached', '--name-only']).trim().split('\n').filter(Boolean)
}

describe('createInitialCommit', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orca-initial-commit-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates an empty commit in a normal unborn repository', async () => {
    initRepo(tmpDir)
    configureIdentity(tmpDir)

    await expect(createInitialCommit(makeExec(tmpDir))).resolves.toEqual({
      ok: true,
      baseRef: 'main'
    })

    expect(commitCount(tmpDir)).toBe(1)
    expect(headBranch(tmpDir)).toBe('main')
    expect(headTreeEntries(tmpDir)).toBe('')
  })

  it('does not commit staged files in a normal unborn repository', async () => {
    initRepo(tmpDir)
    configureIdentity(tmpDir)
    writeFileSync(path.join(tmpDir, 'staged.txt'), 'staged content\n')
    git(tmpDir, ['add', 'staged.txt'])

    await expect(createInitialCommit(makeExec(tmpDir))).resolves.toEqual({
      ok: true,
      baseRef: 'main'
    })

    expect(commitCount(tmpDir)).toBe(1)
    expect(headTreeEntries(tmpDir)).toBe('')
    expect(getStagedNames(tmpDir)).toEqual(['staged.txt'])
  })

  it('returns a custom unborn branch as the explicit base ref', async () => {
    initRepo(tmpDir, 'trunk')
    configureIdentity(tmpDir)

    await expect(createInitialCommit(makeExec(tmpDir))).resolves.toEqual({
      ok: true,
      baseRef: 'trunk'
    })

    expect(commitCount(tmpDir)).toBe(1)
    expect(headBranch(tmpDir)).toBe('trunk')
  })

  it('creates a bare unborn repository ref through plumbing', async () => {
    initBareRepo(tmpDir)
    configureIdentity(tmpDir)

    await expect(createInitialCommit(makeExec(tmpDir))).resolves.toEqual({
      ok: true,
      baseRef: 'main'
    })

    expect(git(tmpDir, ['rev-parse', '--verify', 'refs/heads/main^{commit}']).trim()).toMatch(
      /^[0-9a-f]{40}$/
    )
  })

  it('creates a sha256 bare unborn repository ref through plumbing when supported', async () => {
    try {
      initBareRepo(tmpDir, ['--object-format=sha256'])
    } catch {
      return
    }
    configureIdentity(tmpDir)

    await expect(createInitialCommit(makeExec(tmpDir))).resolves.toEqual({
      ok: true,
      baseRef: 'main'
    })

    expect(git(tmpDir, ['rev-parse', '--show-object-format']).trim()).toBe('sha256')
    expect(git(tmpDir, ['rev-parse', '--verify', 'refs/heads/main^{commit}']).trim()).toMatch(
      /^[0-9a-f]{64}$/
    )
  })

  it('creates a bare unborn custom HEAD ref and returns its short name', async () => {
    initBareRepo(tmpDir)
    configureIdentity(tmpDir)
    git(tmpDir, ['symbolic-ref', 'HEAD', 'refs/heads/trunk'])

    await expect(createInitialCommit(makeExec(tmpDir))).resolves.toEqual({
      ok: true,
      baseRef: 'trunk'
    })

    expect(git(tmpDir, ['rev-parse', '--verify', 'refs/heads/trunk^{commit}']).trim()).toMatch(
      /^[0-9a-f]{40}$/
    )
  })

  it('no-ops when a main commit already exists', async () => {
    initRepo(tmpDir)
    configureIdentity(tmpDir)
    git(tmpDir, ['commit', '--allow-empty', '-m', 'existing', '--quiet'])
    const before = headSha(tmpDir)

    await expect(createInitialCommit(makeExec(tmpDir))).resolves.toEqual({
      ok: true,
      baseRef: 'main'
    })

    expect(headSha(tmpDir)).toBe(before)
    expect(commitCount(tmpDir)).toBe(1)
  })

  it('no-ops on an unrecognized branch with commits and returns HEAD branch', async () => {
    initRepo(tmpDir, 'develop')
    configureIdentity(tmpDir)
    git(tmpDir, ['commit', '--allow-empty', '-m', 'existing', '--quiet'])
    const before = headSha(tmpDir)

    await expect(createInitialCommit(makeExec(tmpDir))).resolves.toEqual({
      ok: true,
      baseRef: 'develop'
    })

    expect(headSha(tmpDir)).toBe(before)
    expect(commitCount(tmpDir)).toBe(1)
  })

  it('no-ops in a non-bare unborn repository when another local branch exists', async () => {
    initRepo(tmpDir)
    configureIdentity(tmpDir)
    const developSha = makeCommitObject(tmpDir)
    git(tmpDir, ['update-ref', 'refs/heads/develop', developSha])

    await expect(createInitialCommit(makeExec(tmpDir))).resolves.toEqual({
      ok: true,
      baseRef: 'develop'
    })

    expect(git(tmpDir, ['rev-parse', 'refs/heads/develop']).trim()).toBe(developSha)
    expect(() => git(tmpDir, ['rev-parse', '--verify', 'refs/heads/main'])).toThrow()
  })

  it('no-ops in a bare unborn repository when another local branch exists', async () => {
    initBareRepo(tmpDir)
    configureIdentity(tmpDir)
    const developSha = makeCommitObject(tmpDir)
    git(tmpDir, ['update-ref', 'refs/heads/develop', developSha])

    await expect(createInitialCommit(makeExec(tmpDir))).resolves.toEqual({
      ok: true,
      baseRef: 'develop'
    })

    expect(git(tmpDir, ['rev-parse', 'refs/heads/develop']).trim()).toBe(developSha)
    expect(() => git(tmpDir, ['rev-parse', '--verify', 'refs/heads/main'])).toThrow()
  })

  it('no-ops with a remote-only branch and skips remote HEAD symrefs', async () => {
    initBareRepo(tmpDir)
    configureIdentity(tmpDir)
    const remoteSha = makeCommitObject(tmpDir)
    git(tmpDir, ['update-ref', 'refs/remotes/origin/develop', remoteSha])
    git(tmpDir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])

    await expect(createInitialCommit(makeExec(tmpDir))).resolves.toEqual({
      ok: true,
      baseRef: 'origin/develop'
    })

    expect(git(tmpDir, ['rev-parse', 'refs/remotes/origin/develop']).trim()).toBe(remoteSha)
    expect(() => git(tmpDir, ['rev-parse', '--verify', 'refs/heads/main'])).toThrow()
  })

  it('bounds fallback branch enumeration to one ref per namespace', async () => {
    const calls: string[][] = []
    const exec = (async (argv) => {
      calls.push(argv)
      if (argv[0] === 'symbolic-ref' && argv[1] === '--short') {
        return { stdout: 'main\n' }
      }
      if (argv[0] === 'for-each-ref' && argv.includes('refs/heads')) {
        expect(argv).toContain('--count=1')
        return { stdout: '' }
      }
      if (argv[0] === 'for-each-ref' && argv.includes('refs/remotes')) {
        expect(argv).toContain('--count=1')
        expect(argv).toContain('--exclude=refs/remotes/*/HEAD')
        return { stdout: 'origin/develop\n' }
      }
      throw new Error(`simulated git failure: ${argv.join(' ')}`)
    }) satisfies GitExec

    await expect(createInitialCommit(exec)).resolves.toEqual({
      ok: true,
      baseRef: 'origin/develop'
    })

    const refCalls = calls.filter((argv) => argv[0] === 'for-each-ref')
    expect(refCalls).toHaveLength(2)
  })

  it('maps missing identity failures to the shared guidance message', async () => {
    initRepo(tmpDir)
    const isolatedEnv = { ...process.env }
    for (const key of [
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'GIT_COMMITTER_NAME',
      'GIT_COMMITTER_EMAIL',
      'EMAIL'
    ]) {
      delete isolatedEnv[key]
    }
    Object.assign(isolatedEnv, {
      GIT_CONFIG_GLOBAL: path.join(tmpDir, 'missing-global-config'),
      GIT_CONFIG_SYSTEM: path.join(tmpDir, 'missing-system-config'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.useConfigOnly',
      GIT_CONFIG_VALUE_0: 'true'
    })

    await expect(createInitialCommit(makeExec(tmpDir, isolatedEnv))).resolves.toEqual({
      ok: false,
      error: GIT_IDENTITY_GUIDANCE_MESSAGE
    })
  })

  it('coalesces concurrent serialized calls for the same repo', async () => {
    initRepo(tmpDir)
    configureIdentity(tmpDir)
    let commitTreeCalls = 0
    const exec = (async (argv) => {
      if (argv[0] === 'commit-tree') {
        commitTreeCalls += 1
      }
      return { stdout: git(tmpDir, argv) }
    }) satisfies GitExec

    const [first, second] = await Promise.all([
      createInitialCommitSerialized('repo-1', exec),
      createInitialCommitSerialized('repo-1', exec)
    ])

    expect(first).toEqual({ ok: true, baseRef: 'main' })
    expect(second).toEqual(first)
    expect(commitTreeCalls).toBe(1)
    expect(commitCount(tmpDir)).toBe(1)
  })

  it('recovers when bare update-ref compare-and-swap loses a race', async () => {
    initBareRepo(tmpDir)
    configureIdentity(tmpDir)
    let racedSha: string | null = null
    let updateRefCalls = 0
    const exec = (async (argv) => {
      if (argv[0] === 'update-ref') {
        updateRefCalls += 1
        if (racedSha) {
          git(tmpDir, ['update-ref', 'refs/heads/main', racedSha])
        }
      }
      const result = { stdout: git(tmpDir, argv) }
      if (argv[0] === 'commit-tree') {
        racedSha = result.stdout.trim()
      }
      return result
    }) satisfies GitExec

    await expect(createInitialCommit(exec)).resolves.toEqual({
      ok: true,
      baseRef: 'main'
    })

    expect(updateRefCalls).toBe(1)
    expect(git(tmpDir, ['rev-parse', 'refs/heads/main']).trim()).toBe(racedSha)
  })

  it('falls back to main for a bare unborn repository with unusual HEAD', async () => {
    initBareRepo(tmpDir)
    configureIdentity(tmpDir)
    git(tmpDir, ['symbolic-ref', 'HEAD', 'refs/tags/bootstrap'])

    await expect(createInitialCommit(makeExec(tmpDir))).resolves.toEqual({
      ok: true,
      baseRef: 'main'
    })

    expect(git(tmpDir, ['rev-parse', '--verify', 'refs/heads/main^{commit}']).trim()).toMatch(
      /^[0-9a-f]{40}$/
    )
  })

  it('falls back to main for a bare unborn repository when HEAD symbolic-ref fails', async () => {
    const createdRefs: string[] = []
    const sha = '1'.repeat(40)
    const exec = (async (argv) => {
      if (argv[0] === 'rev-parse' && argv[1] === '--is-bare-repository') {
        return { stdout: 'true\n' }
      }
      if (argv[0] === 'commit-tree') {
        return { stdout: `${sha}\n` }
      }
      if (argv[0] === 'update-ref') {
        createdRefs.push(argv[1] ?? '')
        return { stdout: '' }
      }
      throw new Error(`simulated git failure: ${argv.join(' ')}`)
    }) satisfies GitExec

    await expect(createInitialCommit(exec)).resolves.toEqual({
      ok: true,
      baseRef: 'main'
    })

    expect(createdRefs).toEqual(['refs/heads/main'])
  })

  it('returns the commit sha for a non-bare repository with detached HEAD', async () => {
    initRepo(tmpDir, 'develop')
    configureIdentity(tmpDir)
    git(tmpDir, ['commit', '--allow-empty', '-m', 'existing', '--quiet'])
    const before = headSha(tmpDir)
    git(tmpDir, ['checkout', '--detach', before, '--quiet'])

    await expect(createInitialCommit(makeExec(tmpDir))).resolves.toEqual({
      ok: true,
      baseRef: before
    })

    expect(headSha(tmpDir)).toBe(before)
    expect(commitCount(tmpDir)).toBe(1)
  })
})
