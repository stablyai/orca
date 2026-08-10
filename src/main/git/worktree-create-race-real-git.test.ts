import { execFile, spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GitExec } from '../../relay/git-handler-ops'
import { addWorktreeOp } from '../../relay/git-handler-worktree-ops'
import { addWorktree } from './worktree'

const execFileAsync = promisify(execFile)

let root = ''
let repo = ''
let forkedEntry = ''

async function git(args: string[], cwd = repo): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd })
}

async function initializeRepository(): Promise<void> {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-worktree-create-race-')))
  repo = join(root, 'repo')
  await mkdir(repo)
  await git(['init', '-q'])
  await git(['config', 'user.email', 'race@example.invalid'])
  await git(['config', 'user.name', 'Worktree Race'])
  await writeFile(join(repo, 'seed.txt'), 'seed\n')
  await git(['add', 'seed.txt'])
  await git(['commit', '-qm', 'seed'])
  await mkdir(join(repo, '.git', 'git-crypt'))
  forkedEntry = join(root, 'worktree-create-forked-attempt.mjs')
  await build({
    entryPoints: [join(__dirname, 'worktree-create-forked-attempt.ts')],
    outfile: forkedEntry,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    logLevel: 'silent'
  })
}

async function expectWinnerPreserved(target: string, branch: string): Promise<void> {
  const { stdout: worktrees } = await git(['worktree', 'list', '--porcelain'])
  const { stdout: head } = await git(['rev-parse', '--verify', `refs/heads/${branch}`])
  expect(worktrees).toContain(`worktree ${target}`)
  expect(worktrees).toContain(`branch refs/heads/${branch}`)
  expect(head.trim()).toMatch(/^[0-9a-f]{40,64}$/)
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function spawnCreateAttempt(
  coordinationDir: string,
  attempt: string,
  target: string,
  branch: string
): Promise<number | null> {
  const child = spawn(process.execPath, [forkedEntry], {
    env: {
      ...process.env,
      ORCA_FORKED_CREATE_REPO: repo,
      ORCA_FORKED_CREATE_TARGET: target,
      ORCA_FORKED_CREATE_BRANCH: branch,
      ORCA_FORKED_CREATE_COORDINATION: coordinationDir,
      ORCA_FORKED_CREATE_ATTEMPT: attempt
    },
    stdio: 'ignore'
  })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
}

async function releaseCapturedAttempts(coordinationDir: string): Promise<void> {
  const firstCapture = join(coordinationDir, 'captured-one')
  const secondCapture = join(coordinationDir, 'captured-two')
  const expiresAt = Date.now() + 5_000
  while (!(await pathExists(firstCapture)) && !(await pathExists(secondCapture))) {
    if (Date.now() >= expiresAt) {
      throw new Error('No forked worktree attempt reached ownership capture')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  while (!(await pathExists(firstCapture)) || !(await pathExists(secondCapture))) {
    if (Date.now() >= expiresAt) {
      throw new Error('Forked worktree attempts did not reach lock resolution together')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await writeFile(join(coordinationDir, 'release'), '')
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

beforeEach(initializeRepository)
afterEach(async () => rm(root, { recursive: true, force: true }))

describe('same-target worktree create race against real Git', () => {
  it('serializes synchronized worktree creation across host processes', async () => {
    const target = join(root, 'winner-forked')
    const branch = 'race/forked'
    const coordinationDir = join(root, 'forked-coordination')
    await mkdir(coordinationDir)

    const attempts = [
      spawnCreateAttempt(coordinationDir, 'one', target, branch),
      spawnCreateAttempt(coordinationDir, 'two', target, branch)
    ]
    await releaseCapturedAttempts(coordinationDir)
    const exitCodes = await Promise.all(attempts)

    expect(exitCodes.filter((code) => code === 0)).toHaveLength(1)
    expect(await pathExists(join(coordinationDir, 'overlap-observed'))).toBe(false)
    await expectWinnerPreserved(target, branch)
  })

  it('serializes case-variant aliases on a case-insensitive filesystem', async () => {
    const upperTarget = join(root, 'CaseTarget')
    const lowerTarget = join(root, 'casetarget')
    const probe = join(root, 'CaseProbe')
    await mkdir(probe)
    if (!(await pathExists(join(root, 'caseprobe')))) {
      return
    }

    const lockResolutionReady = deferred()
    let lockResolutionCount = 0
    let activeAdds = 0
    let maxActiveAdds = 0
    const relayGit: GitExec = async (args, cwd, options) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        lockResolutionCount += 1
        if (lockResolutionCount === 2) {
          lockResolutionReady.resolve()
        }
        await Promise.race([
          lockResolutionReady.promise,
          new Promise((resolve) => setTimeout(resolve, 150))
        ])
      }
      const isAdd = args[0] === 'worktree' && args[1] === 'add'
      if (isAdd) {
        activeAdds += 1
        maxActiveAdds = Math.max(maxActiveAdds, activeAdds)
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      try {
        return await execFileAsync('git', args, {
          cwd,
          signal: options?.signal,
          timeout: options?.timeout
        })
      } finally {
        if (isAdd) {
          activeAdds -= 1
        }
      }
    }

    const attempts = await Promise.allSettled([
      addWorktreeOp(relayGit, {
        repoPath: repo,
        targetDir: upperTarget,
        branchName: 'race/case-upper'
      }),
      addWorktreeOp(relayGit, {
        repoPath: repo,
        targetDir: lowerTarget,
        branchName: 'race/case-lower'
      })
    ])

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(maxActiveAdds).toBe(1)
    const { stdout } = await git(['worktree', 'list', '--porcelain'])
    expect(stdout.toLowerCase()).toContain(`worktree ${lowerTarget}`.toLowerCase())
  })

  it('keeps the local winner registered after the serialized loser fails', async () => {
    const target = join(root, 'winner-local')
    const branch = 'race/local'
    const attempts = await Promise.allSettled([
      addWorktree(repo, target, branch),
      addWorktree(repo, target, branch)
    ])

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)
    await expectWinnerPreserved(target, branch)
  })

  it('keeps the relay winner registered after the serialized loser fails', async () => {
    const target = join(root, 'winner-relay')
    const branch = 'race/relay'
    const relayGit: GitExec = async (args, cwd, options) =>
      execFileAsync('git', args, {
        cwd,
        signal: options?.signal,
        timeout: options?.timeout
      })
    const params = { repoPath: repo, targetDir: target, branchName: branch }
    const attempts = await Promise.allSettled([
      addWorktreeOp(relayGit, params),
      addWorktreeOp(relayGit, params)
    ])

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)
    await expectWinnerPreserved(target, branch)
  })

  it('serializes main, linked, repository-symlink, and target-symlink aliases', async () => {
    const source = join(root, 'linked-source')
    await git(['worktree', 'add', '-q', '-b', 'race/source', source])
    const repoAlias = join(root, 'repo-alias')
    await symlink(repo, repoAlias, process.platform === 'win32' ? 'junction' : 'dir')
    const targetParent = join(root, 'targets')
    const targetParentAlias = join(root, 'targets-alias')
    await mkdir(targetParent)
    await symlink(
      targetParent,
      targetParentAlias,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const target = join(targetParent, 'winner-alias')
    const repoAliasRelative = relative(process.cwd(), repoAlias)
    const targetAliasRelative = `${relative(repoAlias, targetParentAlias)}${sep}unused${sep}..${sep}winner-alias`
    const branch = 'race/common-dir-alias'
    const relayGit: GitExec = async (args, cwd, options) =>
      execFileAsync('git', args, {
        cwd,
        signal: options?.signal,
        timeout: options?.timeout
      })

    const attempts = await Promise.allSettled([
      addWorktree(repoAliasRelative, targetAliasRelative, branch),
      addWorktreeOp(relayGit, { repoPath: source, targetDir: target, branchName: branch })
    ])

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)
    await expectWinnerPreserved(target, branch)
  })
})
