import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installRealWorkerThreadChildProcesses } from '../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { switchBranchGuarded, type BranchSwitchDeps } from './branch-switch'
import { checkoutBranch } from './checkout'
import { getStatus } from './source-control/status-read'

let directory: string

async function git(...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd: directory })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout.trim()
}

function deps(agentBlocker: string | null = null): BranchSwitchDeps {
  return {
    getStatus: () => getStatus(directory, { includeLineStats: false }),
    checkout: () => checkoutBranch(directory, 'feature'),
    getAgentBlocker: async () => agentBlocker
  }
}

async function currentBranch(): Promise<string> {
  return git('symbolic-ref', '--short', 'HEAD')
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-branch-switch-'))
  await git('init', '-q')
  await git('symbolic-ref', 'HEAD', 'refs/heads/main')
  await git('config', 'user.name', 'Audit')
  await git('config', 'user.email', 'audit@example.test')
  await git('config', 'commit.gpgsign', 'false')
  await git('config', 'core.hooksPath', '')
  await writeFile(join(directory, 'file.txt'), 'base\n')
  await git('add', 'file.txt')
  await git('commit', '-qm', 'base')
  await git('branch', 'feature')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('switchBranchGuarded', () => {
  it('switches a clean checkout and reports the branch it left', async () => {
    const result = await switchBranchGuarded(directory, 'feature', {}, deps())

    expect(result).toEqual({ branch: 'feature', previousBranch: 'main' })
    expect(await currentBranch()).toBe('feature')
  })

  it('serializes concurrent switches so only one checks a clean tree and moves HEAD', async () => {
    const outcomes = await Promise.allSettled([
      switchBranchGuarded(directory, 'feature', {}, deps()),
      switchBranchGuarded(directory, 'feature', {}, deps())
    ])

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled'])
    const results = outcomes.map((outcome) =>
      outcome.status === 'fulfilled' ? outcome.value : null
    )
    expect(results.map((result) => result?.previousBranch)).toEqual(['main', null])
  })
})

installRealWorkerThreadChildProcesses()
