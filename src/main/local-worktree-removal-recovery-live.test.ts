import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { recoverLocalWindowsWorktreeRemoval } from './local-worktree-removal-recovery'

const tempRoots: string[] = []

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`)
  }
  return result.stdout.trim()
}

async function waitForPath(targetPath: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!existsSync(targetPath)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${targetPath}`)
    }
    await delay(20)
  }
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill()
  await Promise.race([exited, delay(500)])
  if (child.exitCode === null && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    await Promise.race([exited, delay(2_000)])
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error('Failed to stop the filesystem churn process')
  }
}

describe('local Windows worktree removal recovery (live Git)', () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }))
    )
  })

  it.runIf(process.platform === 'win32')(
    'finishes deletion when Git deregisters before a directory-not-empty failure',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'orca-worktree-enotempty-'))
      tempRoots.push(root)
      const repoPath = path.join(root, 'repo')
      const worktreePath = path.join(root, 'worktree')

      git(root, ['init', '--quiet', repoPath])
      git(repoPath, ['config', 'user.email', 'test@example.com'])
      git(repoPath, ['config', 'user.name', 'Test User'])
      await writeFile(path.join(repoPath, '.gitignore'), 'churn/\n')
      git(repoPath, ['add', '.gitignore'])
      git(repoPath, ['commit', '--quiet', '-m', 'initial'])
      git(repoPath, ['worktree', 'add', '--quiet', '-b', 'feature/churn', worktreePath])
      const head = git(worktreePath, ['rev-parse', 'HEAD'])

      // Why: a producer racing Git's recursive delete deterministically exposes
      // the Windows ENOTEMPTY state reported by real workspace deletions.
      const churn = spawn(
        process.execPath,
        [
          '-e',
          [
            "const fs = require('node:fs')",
            "const path = require('node:path')",
            'const root = process.argv[1]',
            'let i = 0',
            'while (fs.existsSync(root)) {',
            '  try {',
            "    const dir = path.join(root, 'churn')",
            '    fs.mkdirSync(dir, { recursive: true })',
            "    fs.writeFileSync(path.join(dir, 'f' + (i++ % 64) + '.txt'), 'x')",
            '  } catch {}',
            '}'
          ].join('\n'),
          worktreePath
        ],
        { stdio: 'ignore' }
      )

      try {
        await waitForPath(path.join(worktreePath, 'churn'))
        const removal = spawnSync('git', ['worktree', 'remove', worktreePath], {
          cwd: repoPath,
          encoding: 'utf8'
        })
        expect(removal.status).not.toBe(0)
        expect(git(repoPath, ['worktree', 'list', '--porcelain'])).not.toContain(worktreePath)
        expect(existsSync(worktreePath)).toBe(true)

        await stopProcess(churn)
        await expect(
          recoverLocalWindowsWorktreeRemoval({
            error: Object.assign(new Error('git worktree remove failed'), {
              stderr: removal.stderr
            }),
            force: false,
            canonicalWorktreePath: worktreePath,
            repoPath,
            localWorktreeGitOptions: {},
            registeredWorktree: { branch: 'refs/heads/feature/churn', head },
            deleteBranch: false,
            closeWatcher: async () => {}
          })
        ).resolves.toEqual({})

        expect(existsSync(worktreePath)).toBe(false)
      } finally {
        await stopProcess(churn)
      }
    }
  )
})
