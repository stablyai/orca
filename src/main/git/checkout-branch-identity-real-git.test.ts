import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installRealWorkerThreadChildProcesses } from '../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { checkoutBranch, listLocalBranches } from './checkout'

let directory: string

async function git(...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd: directory })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout.trim()
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-branch-identity-'))
  await git('init', '-q')
  await git('symbolic-ref', 'HEAD', 'refs/heads/main')
  await git('config', 'user.name', 'Audit')
  await git('config', 'user.email', 'audit@example.test')
  await git('config', 'commit.gpgsign', 'false')
  await git('config', 'core.hooksPath', '')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('local branch picker identities', () => {
  it('keeps HEAD attached when selecting a branch that shares a name with a tag', async () => {
    await git('commit', '--allow-empty', '-qm', 'base')
    await git('branch', 'release')
    await git('commit', '--allow-empty', '-qm', 'tag target')
    await git('tag', 'release')
    const listing = await listLocalBranches(directory)
    expect(listing.branches).toEqual(['main', 'release'])

    await checkoutBranch(directory, listing.branches[1])

    expect(await git('symbolic-ref', '--quiet', 'HEAD')).toBe('refs/heads/release')
  })
})

installRealWorkerThreadChildProcesses()
