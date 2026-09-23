import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { GitCapabilityCache } from '../../shared/git-capability-cache'
import { refreshLocalBaseRefForWorktreeCreateOp } from '../../relay/git-handler-local-base-ref-refresh'
import { refreshLocalBaseRefForWorktreeCreate } from './worktree-base-refresh'

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('./runner', () => ({
  gitExecFileAsync: execute,
  translateWslOutputPaths: (output: string) => output
}))

describe.each(['native', 'relay'] as const)('%s base refresh preserves local data', (host) => {
  let repoPath: string
  let localBranch: string
  let originalOid: string
  let remoteOid: string
  let beforeMutation: (() => Promise<void>) | undefined

  async function git(args: string[], cwd = repoPath) {
    const result = await runProcess({
      program: process.env.ORCA_GIT_COMPAT_BINARY ?? 'git',
      args,
      cwd,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(repoPath, 'xdg-config'),
        GIT_CONFIG_GLOBAL: join(repoPath, 'empty-config'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_COUNT: '0',
        GIT_TERMINAL_PROMPT: '0'
      }
    })
    if (result.code !== 0) {
      throw new Error(result.stderr)
    }
    return result
  }

  async function executeGit(args: string[], cwd: string) {
    if (beforeMutation && (args[0] === 'reset' || args.includes('merge'))) {
      const mutate = beforeMutation
      beforeMutation = undefined
      await mutate()
    }
    return git(args, cwd)
  }

  async function refresh() {
    if (host === 'native') {
      return refreshLocalBaseRefForWorktreeCreate(
        repoPath,
        `origin/${localBranch}`,
        `refs/remotes/origin/${localBranch}`
      )
    }
    await refreshLocalBaseRefForWorktreeCreateOp(
      executeGit,
      {
        repoPath,
        fullRef: `refs/heads/${localBranch}`,
        remoteTrackingRef: `refs/remotes/origin/${localBranch}`,
        ownerWorktreePath: repoPath
      },
      new GitCapabilityCache()
    )
    return { status: 'updated' }
  }

  async function expectRefusal() {
    if (host === 'native') {
      expect(await refresh()).toMatchObject({ status: 'skipped_error' })
    } else {
      await expect(refresh()).rejects.toThrow()
    }
  }

  async function head() {
    return (await git(['rev-parse', 'HEAD'])).stdout.trim()
  }

  beforeEach(async () => {
    repoPath = await realpath(await mkdtemp(join(tmpdir(), 'orca-base-preservation-')))
    execute.mockImplementation((args: string[], options: { cwd: string }) =>
      executeGit(args, options.cwd)
    )
    beforeMutation = undefined
    localBranch = 'main'
    await git(['init', '-q'])
    await git(['config', 'user.name', 'Orca Test'])
    await git(['config', 'user.email', 'orca@example.invalid'])
    await git(['config', 'commit.gpgSign', 'false'])
    await git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
    await writeFile(join(repoPath, '.gitignore'), '*.local\n')
    await writeFile(join(repoPath, 'base.txt'), 'base\n')
    await git(['add', '.'])
    await git(['commit', '-qm', 'initial'])
    originalOid = await head()
    await writeFile(join(repoPath, 'incoming.txt'), 'remote\n')
    await writeFile(join(repoPath, 'incoming.local'), 'remote ignored\n')
    await git(['add', '-f', 'incoming.txt', 'incoming.local'])
    await git(['commit', '-qm', 'remote update'])
    remoteOid = await head()
    await git(['update-ref', 'refs/remotes/origin/main', remoteOid])
    await git(['reset', '--hard', originalOid])
  })

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it.each(['incoming.txt', 'incoming.local'])(
    'refuses to overwrite local-only %s',
    async (file) => {
      await writeFile(join(repoPath, file), 'local contents\n')
      await expectRefusal()
      expect(await readFile(join(repoPath, file), 'utf8')).toBe('local contents\n')
      expect(await head()).toBe(originalOid)
      expect((await git(['diff', '--cached', '--name-only'])).stdout).toBe('')
    }
  )

  it.each(['incoming.txt', 'incoming.local'])(
    'refuses to replace a local-only directory at %s',
    async (file) => {
      await mkdir(join(repoPath, file))
      await writeFile(join(repoPath, file, 'data'), 'nested local contents\n')
      await expectRefusal()
      expect(await readFile(join(repoPath, file, 'data'), 'utf8')).toBe('nested local contents\n')
      expect(await head()).toBe(originalOid)
    }
  )

  it('fast-forwards a clean checkout and preserves noncolliding local-only files', async () => {
    await writeFile(join(repoPath, 'notes.txt'), 'notes\n')
    await writeFile(join(repoPath, 'cache.local'), 'cache\n')
    expect(await refresh()).toMatchObject({ status: 'updated' })
    expect(await head()).toBe(remoteOid)
    expect(await readFile(join(repoPath, 'incoming.txt'), 'utf8')).toBe('remote\n')
    expect(await readFile(join(repoPath, 'notes.txt'), 'utf8')).toBe('notes\n')
    expect(await readFile(join(repoPath, 'cache.local'), 'utf8')).toBe('cache\n')
  })

  it.each([false, true])('skips tracked dirt (staged: %s)', async (staged) => {
    await writeFile(join(repoPath, 'base.txt'), 'local edit\n')
    if (staged) {
      await git(['add', 'base.txt'])
    }
    if (host === 'native') {
      expect(await refresh()).toMatchObject({ status: 'skipped_dirty_worktree' })
    } else {
      await expect(refresh()).rejects.toThrow('tracked changes')
    }
    expect(await head()).toBe(originalOid)
    expect(await readFile(join(repoPath, 'base.txt'), 'utf8')).toBe('local edit\n')
  })

  it('does not discard a divergent commit created after preflight', async () => {
    let advancedOid = ''
    beforeMutation = async () => {
      await writeFile(join(repoPath, 'local-commit.txt'), 'local commit\n')
      await git(['add', 'local-commit.txt'])
      await git(['commit', '-qm', 'concurrent local commit'])
      advancedOid = await head()
    }
    await expectRefusal()
    expect(await head()).toBe(advancedOid)
    expect(await readFile(join(repoPath, 'local-commit.txt'), 'utf8')).toBe('local commit\n')
    await expect(readFile(join(repoPath, '.git', 'MERGE_HEAD'))).rejects.toThrow()
  })

  it('does not rewind a branch advanced beyond the remote after preflight', async () => {
    let advancedOid = ''
    beforeMutation = async () => {
      await git(['reset', '--hard', remoteOid])
      await git(['commit', '--allow-empty', '-qm', 'concurrent advance'])
      advancedOid = await head()
    }
    await refresh()
    expect(await head()).toBe(advancedOid)
  })

  it('ignores merge preferences and does not run merge hooks', async () => {
    await git(['config', 'merge.ff', 'false'])
    await git(['config', 'merge.autoStash', 'true'])
    await git(['config', 'branch.main.mergeOptions', '--squash --autostash'])
    const hooks = join(repoPath, '.git', 'custom-hooks')
    await mkdir(hooks)
    await git(['config', 'core.hooksPath', hooks])
    const hook = join(hooks, 'post-merge')
    await writeFile(hook, '#!/bin/sh\necho called > hook-called\n')
    await chmod(hook, 0o755)
    expect(await refresh()).toMatchObject({ status: 'updated' })
    expect(await head()).toBe(remoteOid)
    await expect(readFile(join(repoPath, 'hook-called'))).rejects.toThrow()
    expect((await git(['stash', 'list'])).stdout).toBe('')
  })

  it('refuses an equals-containing branch before merge can squash into the index', async () => {
    localBranch = 'base=custom'
    await git(['branch', '-m', localBranch])
    await git(['update-ref', `refs/remotes/origin/${localBranch}`, remoteOid])
    await git(['config', `branch.${localBranch}.mergeOptions`, '--squash'])
    await writeFile(join(repoPath, 'notes.txt'), 'notes\n')
    await writeFile(join(repoPath, 'cache.local'), 'cache\n')
    const indexBefore = await readFile(join(repoPath, '.git', 'index'))
    await expectRefusal()
    expect(await head()).toBe(originalOid)
    expect(await readFile(join(repoPath, '.git', 'index'))).toEqual(indexBefore)
    expect((await git(['diff', '--cached', '--name-only'])).stdout).toBe('')
    expect(await readFile(join(repoPath, 'notes.txt'), 'utf8')).toBe('notes\n')
    expect(await readFile(join(repoPath, 'cache.local'), 'utf8')).toBe('cache\n')
    await expect(readFile(join(repoPath, 'incoming.txt'))).rejects.toThrow()
    await expect(readFile(join(repoPath, 'incoming.local'))).rejects.toThrow()
  })

  it('can refresh an equals-containing branch that is not checked out', async () => {
    localBranch = 'base=custom'
    await git(['branch', '-m', localBranch])
    await git(['update-ref', `refs/remotes/origin/${localBranch}`, remoteOid])
    await git(['config', `branch.${localBranch}.mergeOptions`, '--squash'])
    await git(['checkout', '--detach', originalOid])
    const indexBefore = await readFile(join(repoPath, '.git', 'index'))
    expect(await refresh()).toMatchObject({ status: 'updated' })
    expect((await git(['rev-parse', `refs/heads/${localBranch}`])).stdout.trim()).toBe(remoteOid)
    expect(await head()).toBe(originalOid)
    expect(await readFile(join(repoPath, '.git', 'index'))).toEqual(indexBefore)
  })

  it.each(['release/2026.09', 'base"quoted', "base'quoted", 'Base.MixedCase'])(
    'clears merge preferences for branch %s',
    async (branch) => {
      localBranch = branch
      await git(['branch', '-m', localBranch])
      await git(['update-ref', `refs/remotes/origin/${localBranch}`, remoteOid])
      await git(['config', `branch.${localBranch}.mergeOptions`, '--squash'])
      expect(await refresh()).toMatchObject({ status: 'updated' })
      expect(await head()).toBe(remoteOid)
      expect((await git(['diff', '--cached', '--name-only'])).stdout).toBe('')
    }
  )

  it('preserves tracked edits made after preflight without autostashing', async () => {
    await git(['reset', '--hard', remoteOid])
    await writeFile(join(repoPath, 'base.txt'), 'remote edit\n')
    await git(['add', 'base.txt'])
    await git(['commit', '-qm', 'remote tracked update'])
    remoteOid = await head()
    await git(['update-ref', 'refs/remotes/origin/main', remoteOid])
    await git(['reset', '--hard', originalOid])
    await writeFile(join(repoPath, 'base.txt'), 'existing stashed edit\n')
    await git(['stash', 'push', '-m', 'existing stash'])
    const stashBefore = (await git(['stash', 'list', '--format=%H'])).stdout
    const indexBefore = await readFile(join(repoPath, '.git', 'index'))
    await git(['config', 'merge.autoStash', 'true'])
    beforeMutation = async () => {
      await writeFile(join(repoPath, 'base.txt'), 'late local edit\n')
    }
    await expectRefusal()
    expect(beforeMutation).toBeUndefined()
    expect(await head()).toBe(originalOid)
    expect(await readFile(join(repoPath, '.git', 'index'))).toEqual(indexBefore)
    expect(await readFile(join(repoPath, 'base.txt'), 'utf8')).toBe('late local edit\n')
    expect((await git(['stash', 'list', '--format=%H'])).stdout).toBe(stashBefore)
    expect((await git(['diff', '--cached', '--name-only'])).stdout).toBe('')
    for (const file of ['MERGE_HEAD', 'MERGE_AUTOSTASH']) {
      await expect(readFile(join(repoPath, '.git', file))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    await expect(readFile(join(repoPath, 'incoming.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(repoPath, 'incoming.local'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})
