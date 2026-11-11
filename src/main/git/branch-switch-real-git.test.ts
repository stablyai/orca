import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installRealWorkerThreadChildProcesses } from '../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import {
  BranchSwitchLandedWithWarningError,
  switchBranchGuarded,
  type BranchSwitchDeps
} from './branch-switch'
import { checkoutBranch } from './checkout'
import { getStatus } from './source-control/status-read'

let directory: string
let initialHead: string

async function git(...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd: directory })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout.trim()
}

function deps(agentBlocker: string | null = null, target = 'feature'): BranchSwitchDeps {
  return {
    getStatus: () => getStatus(directory, { includeLineStats: false }),
    checkout: () =>
      checkoutBranch(directory, target, {
        detached: /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(target)
      }),
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
  initialHead = await git('rev-parse', 'HEAD')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('switchBranchGuarded', () => {
  it.each([false, true])(
    'keeps the checkout refusal when the landed HEAD read fails: %s',
    async (missingHead) => {
      const oid = await git('rev-parse', 'HEAD')
      await writeFile(join(directory, '.git', 'HEAD.lock'), '')
      const dependencies = deps(null, oid)
      const checkout = dependencies.checkout
      dependencies.checkout = async (...args) => {
        try {
          return await checkout(...args)
        } catch (error) {
          if (missingHead) {
            await rename(join(directory, '.git', 'HEAD'), join(directory, '.git', 'saved-HEAD'))
          }
          throw error
        }
      }
      try {
        await switchBranchGuarded(directory, { commitId: oid }, {}, dependencies)
        throw new Error('Expected checkout to fail')
      } catch (error) {
        expect(error).not.toBeInstanceOf(BranchSwitchLandedWithWarningError)
        expect(String(error)).toContain('HEAD.lock')
        expect(String(error)).not.toContain('Command failed:')
        expect(String(error)).not.toContain('\n')
      } finally {
        if (missingHead) {
          await rename(join(directory, '.git', 'saved-HEAD'), join(directory, '.git', 'HEAD'))
        }
      }
      expect(await currentBranch()).toBe('main')
    }
  )
  it('leaves a reachable detached commit and actually checks out the branch', async () => {
    await git('checkout', '--detach', '-q')
    const result = await switchBranchGuarded(directory, 'feature', {}, deps())
    expect(result).toEqual({ branch: 'feature', previousBranch: null, head: initialHead })
    expect(await currentBranch()).toBe('feature')
  })

  it('refuses to abandon a detached commit not reachable from branches, remotes or tags', async () => {
    await git('checkout', '--detach', '-q')
    await git('commit', '--allow-empty', '-qm', 'detached work')
    await expect(switchBranchGuarded(directory, 'feature', {}, deps())).rejects.toThrow(
      'This checkout is on a detached commit. Switch branches from a terminal so commits made here are not lost.'
    )
    expect(await git('log', '-1', '--format=%s')).toBe('detached work')
  })

  it('detaches at the commit even when a branch has the same full object ID as its name', async () => {
    const oid = await git('rev-parse', 'HEAD')
    await git('commit', '--allow-empty', '-qm', 'later')
    await git('branch', oid)
    await switchBranchGuarded(directory, { commitId: oid }, {}, deps(null, oid))
    expect(await git('log', '-1', '--format=%s')).toBe('base')
    expect(await git('branch', '--show-current')).toBe('')
    await switchBranchGuarded(
      directory,
      oid,
      {},
      { ...deps(), checkout: () => checkoutBranch(directory, oid) }
    )
    expect(await currentBranch()).toBe(oid)
    expect(await git('log', '-1', '--format=%s')).toBe('later')
  })

  it('moves between distinct reachable detached commits', async () => {
    const target = await git('rev-parse', 'HEAD')
    await git('commit', '--allow-empty', '-qm', 'later')
    await git('checkout', '--detach', '-q')
    await switchBranchGuarded(directory, { commitId: target }, {}, deps(null, target))
    expect(await git('log', '-1', '--format=%s')).toBe('base')
    expect(await git('branch', '--show-current')).toBe('')
  })

  it('does not check out a detached commit that is already HEAD', async () => {
    const oid = await git('rev-parse', 'HEAD')
    await git('checkout', '--detach', '-q')
    const hooks = join(directory, '.git', 'hooks')
    await git('config', 'core.hooksPath', hooks)
    await mkdir(hooks, { recursive: true })
    await writeFile(join(hooks, 'post-checkout'), '#!/bin/sh\necho should-not-run >&2\nexit 1\n')
    await chmod(join(hooks, 'post-checkout'), 0o755)
    await expect(
      switchBranchGuarded(directory, { commitId: oid }, {}, deps(null, oid))
    ).resolves.toEqual({
      branch: oid,
      previousBranch: null,
      head: oid
    })
  })

  it('reports a landed commit checkout even when its post-checkout hook fails', async () => {
    const oid = await git('rev-parse', 'HEAD')
    await git('commit', '--allow-empty', '-qm', 'later')
    const hooks = join(directory, '.git', 'hooks')
    await git('config', 'core.hooksPath', hooks)
    await mkdir(hooks, { recursive: true })
    await writeFile(join(hooks, 'post-checkout'), '#!/bin/sh\necho hook-failed >&2\nexit 1\n')
    await chmod(join(hooks, 'post-checkout'), 0o755)
    await expect(
      switchBranchGuarded(directory, { commitId: oid }, {}, deps(null, oid))
    ).rejects.toMatchObject({
      name: 'BranchSwitchLandedWithWarningError',
      message: `Switched to ${oid}. A git hook in this repository failed afterwards and said: hook-failed. The switch itself worked.`
    })
    expect(await git('rev-parse', 'HEAD')).toBe(oid)
    expect(await git('branch', '--show-current')).toBe('')
  })

  it('switches a clean checkout and reports the branch it left', async () => {
    const result = await switchBranchGuarded(directory, 'feature', {}, deps())

    expect(result).toEqual({ branch: 'feature', previousBranch: 'main', head: initialHead })
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
