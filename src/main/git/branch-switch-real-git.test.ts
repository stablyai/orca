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

  it('refuses uncommitted and untracked changes instead of carrying them across', async () => {
    await writeFile(join(directory, 'new.txt'), 'draft\n')

    await expect(switchBranchGuarded(directory, 'feature', {}, deps())).rejects.toThrow(
      'Commit or discard 1 changed file (new.txt) before switching branches.'
    )
    expect(await currentBranch()).toBe('main')
  })

  it('refuses while a revert is in progress', async () => {
    await writeFile(join(directory, 'file.txt'), 'changed\n')
    await git('commit', '-qam', 'change')
    await writeFile(join(directory, 'file.txt'), 'conflict\n')
    await git('commit', '-qam', 'conflict')
    await expect(git('revert', '--no-edit', 'HEAD~1')).rejects.toThrow()

    await expect(switchBranchGuarded(directory, 'feature', {}, deps())).rejects.toThrow(
      'Finish or abort the revert in progress before switching branches.'
    )
    expect(await currentBranch()).toBe('main')
  })

  it('refuses edits inside a submodule that ignore config hides, but not a commit mismatch alone', async () => {
    const library = await mkdtemp(join(tmpdir(), 'orca-branch-switch-lib-'))
    try {
      await runProcess({ program: 'git', args: ['init', '-q'], cwd: library })
      await writeFile(join(library, 'lib.txt'), 'lib\n')
      await runProcess({ program: 'git', args: ['add', 'lib.txt'], cwd: library })
      await runProcess({
        program: 'git',
        args: ['-c', 'user.name=A', '-c', 'user.email=a@a.test', 'commit', '-qm', 'lib'],
        cwd: library
      })
      await git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'lib')
      await git('config', '-f', '.gitmodules', 'submodule.lib.ignore', 'all')
      await git('add', '.gitmodules')
      await git('commit', '-qm', 'add lib')
      await git('branch', '-f', 'feature')

      await writeFile(join(directory, 'lib', 'lib.txt'), 'edited\n')
      await expect(switchBranchGuarded(directory, 'feature', {}, deps())).rejects.toThrow(
        'Commit, stash or clean the changes inside submodule lib before switching branches.'
      )
      expect(await currentBranch()).toBe('main')

      // A submodule merely at another commit has nothing a switch could lose.
      const submodule = join(directory, 'lib')
      await runProcess({ program: 'git', args: ['checkout', '--', 'lib.txt'], cwd: submodule })
      await runProcess({
        program: 'git',
        args: [
          '-c',
          'user.name=A',
          '-c',
          'user.email=a@a.test',
          'commit',
          '--allow-empty',
          '-qm',
          'moved'
        ],
        cwd: submodule
      })
      await switchBranchGuarded(directory, 'feature', {}, deps())
      expect(await currentBranch()).toBe('feature')
    } finally {
      await rm(library, { recursive: true, force: true })
    }
  })

  it('refuses with the agent reason when the checkout is otherwise clean', async () => {
    await expect(
      switchBranchGuarded(directory, 'feature', {}, deps('Claude is working in this workspace.'))
    ).rejects.toThrow('Claude is working in this workspace.')
    expect(await currentBranch()).toBe('main')
  })

  it('is a no-op on the current branch, even with changes or a working agent', async () => {
    await writeFile(join(directory, 'new.txt'), 'draft\n')

    const result = await switchBranchGuarded(directory, 'main', {}, deps('busy'))

    expect(result.previousBranch).toBeNull()
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
