import { execFile } from 'node:child_process'
import { access, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { GitExec } from '../../relay/git-handler-ops'
import { addWorktreeOp } from '../../relay/git-handler-worktree-ops'

const execFileAsync = promisify(execFile)

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing ${name}`)
  }
  return value
}

async function waitForFile(filePath: string): Promise<void> {
  const expiresAt = Date.now() + 10_000
  while (Date.now() < expiresAt) {
    try {
      await access(filePath)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}

const repo = required('ORCA_FORKED_CREATE_REPO')
const target = required('ORCA_FORKED_CREATE_TARGET')
const branch = required('ORCA_FORKED_CREATE_BRANCH')
const coordinationDir = required('ORCA_FORKED_CREATE_COORDINATION')
const attemptId = required('ORCA_FORKED_CREATE_ATTEMPT')
const releasePath = join(coordinationDir, 'release')
let captured = false

const git: GitExec = async (args, cwd, options) => {
  if (!captured && args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
    captured = true
    await writeFile(join(coordinationDir, `captured-${attemptId}`), '')
    await waitForFile(releasePath)
  }
  const activePath = join(coordinationDir, `active-${attemptId}`)
  const otherActivePath = join(coordinationDir, `active-${attemptId === 'one' ? 'two' : 'one'}`)
  try {
    if (args[0] === 'worktree' && args[1] === 'add') {
      await writeFile(activePath, '')
      await new Promise((resolve) => setTimeout(resolve, 150))
      try {
        await access(otherActivePath)
        await writeFile(join(coordinationDir, 'overlap-observed'), '')
      } catch {
        // The host lock kept the other process out of Git mutation.
      }
    }
    const result = await execFileAsync('git', args, {
      cwd,
      signal: options?.signal,
      timeout: options?.timeout
    })
    return result
  } finally {
    if (args[0] === 'worktree' && args[1] === 'add') {
      await rm(activePath, { force: true })
    }
  }
}

await addWorktreeOp(git, { repoPath: repo, targetDir: target, branchName: branch })
