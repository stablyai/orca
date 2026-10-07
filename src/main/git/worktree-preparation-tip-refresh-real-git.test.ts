import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorktreePreparationLockReason } from '../../shared/worktree/create-preparation'
import * as runner from './runner'
import {
  finalizePreparedWorktree,
  prepareWorktreeCreateCheckout
} from './worktree-create-preparation'
import { refreshPreparedWorktreeTip } from './worktree-preparation-tip-refresh'
import {
  _resetPreparationPoolForTests,
  listPreparations,
  releasePreparationClaim,
  startPreparation,
  takePreparation
} from '../worktree-create-preparation-pool'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await _resetPreparationPoolForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runner.gitExecFileAsync(args, { cwd })).stdout.trim()
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-fetched-preparation-')))
  roots.push(root)
  const repo = join(root, 'repo')
  const prepared = join(root, 'prepared')
  const final = join(root, 'final')
  await git(root, ['init', '--quiet', repo])
  await git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  await git(repo, ['config', 'user.name', 'Test'])
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await writeFile(join(repo, 'version.txt'), 'original\n')
  await git(repo, ['add', 'version.txt'])
  await git(repo, ['commit', '--quiet', '-m', 'initial'])
  const hooks = join(root, 'hooks')
  await mkdir(hooks)
  await writeFile(join(hooks, 'post-checkout'), '#!/bin/sh\necho checkout >> checkout-hook.txt\n', {
    mode: 0o755
  })
  await git(repo, ['config', 'core.hooksPath', hooks])
  const base = 'refs/remotes/origin/main'
  await git(repo, ['update-ref', base, 'HEAD'])
  const reason = createWorktreePreparationLockReason('fetched-tip')
  await prepareWorktreeCreateCheckout(repo, prepared, base, reason)
  return { root, repo, prepared, final, base, reason }
}

async function advance(repo: string, base: string, text: string): Promise<string> {
  await writeFile(join(repo, 'version.txt'), text)
  await git(repo, ['commit', '--quiet', '-am', text.trim()])
  const head = await git(repo, ['rev-parse', 'HEAD'])
  await git(repo, ['update-ref', base, head])
  return head
}

it('moves changed tip work into prefetch while submit still runs exactly one checkout hook', async () => {
  const { repo, prepared, final, base, reason } = await fixture()
  const target = await advance(repo, base, 'fetched\n')
  const spy = vi.spyOn(runner, 'gitExecFileAsync')
  await refreshPreparedWorktreeTip(repo, prepared, base, reason)
  expect(await readFile(join(prepared, 'version.txt'), 'utf8')).toBe('fetched\n')
  expect(await git(prepared, ['rev-parse', 'HEAD'])).toBe(target)
  expect(existsSync(join(prepared, 'checkout-hook.txt'))).toBe(false)
  expect(spy.mock.calls.filter(([args]) => args.includes('reset'))).toHaveLength(1)
  spy.mockClear()
  await refreshPreparedWorktreeTip(repo, prepared, base, reason)
  await finalizePreparedWorktree(repo, prepared, final, 'feature', base, false, {}, reason)
  expect(spy.mock.calls.filter(([args]) => args.includes('reset'))).toHaveLength(0)
  expect(await readFile(join(final, 'checkout-hook.txt'), 'utf8')).toBe('checkout\n')
  expect(await git(final, ['rev-parse', 'HEAD'])).toBe(target)
  expect(await git(final, ['status', '--porcelain', '--untracked-files=no'])).toBe('')
})

it('revalidates a newer fetched tip that arrives after the background refresh', async () => {
  const { repo, prepared, final, base, reason } = await fixture()
  await advance(repo, base, 'first fetch\n')
  await refreshPreparedWorktreeTip(repo, prepared, base, reason)
  const newest = await advance(repo, base, 'second fetch\n')
  await finalizePreparedWorktree(repo, prepared, final, 'feature', base, false, {}, reason)
  expect(await git(final, ['rev-parse', 'HEAD'])).toBe(newest)
  expect(await readFile(join(final, 'version.txt'), 'utf8')).toBe('second fetch\n')
  expect(await readFile(join(final, 'checkout-hook.txt'), 'utf8')).toBe('checkout\n')
})

it('preserves a competing lock and files when ownership changes before refresh', async () => {
  const { repo, prepared, base, reason } = await fixture()
  await advance(repo, base, 'new fetch\n')
  const lock = await git(prepared, ['rev-parse', '--git-path', 'locked'])
  await writeFile(lock, 'manual owner\n')
  await expect(refreshPreparedWorktreeTip(repo, prepared, base, reason)).rejects.toThrow(
    'lock owner changed'
  )
  expect(await readFile(lock, 'utf8')).toBe('manual owner\n')
  expect(await readFile(join(prepared, 'version.txt'), 'utf8')).toBe('original\n')
  expect(await git(repo, ['worktree', 'list', '--porcelain'])).toContain('locked manual owner')
})

it('makes a racing claim wait for one fetched-tip reset on an already ready checkout', async () => {
  const { root, repo, final, base } = await fixture()
  const args = {
    repoPath: repo,
    workspaceRoot: root,
    baseBranch: base,
    canonicalBase: base,
    options: {}
  }
  await startPreparation(args)
  const entry = listPreparations()[0]!
  let settle!: () => void
  const beforeMaterialization = new Promise<void>((resolve) => {
    settle = resolve
  })
  const spy = vi.spyOn(runner, 'gitExecFileAsync')
  const refreshing = startPreparation({ ...args, beforeMaterialization })
  const claim = takePreparation(entry)
  let finalized = false
  const create = entry.ready.then(async () => {
    await finalizePreparedWorktree(
      repo,
      entry.preparedPath,
      final,
      'feature',
      base,
      false,
      {},
      entry.lockReason
    )
    finalized = true
  })
  try {
    await Promise.resolve()
    expect(finalized).toBe(false)
    expect(spy.mock.calls.filter(([argv]) => argv.includes('reset'))).toHaveLength(0)
    const target = await advance(repo, base, 'fetched ready tip\n')
    expect(finalized).toBe(false)
    settle()
    await Promise.all([refreshing, create])
    expect(spy.mock.calls.filter(([argv]) => argv.includes('reset'))).toHaveLength(1)
    expect(await git(final, ['rev-parse', 'HEAD'])).toBe(target)
    expect(await readFile(join(final, 'version.txt'), 'utf8')).toBe('fetched ready tip\n')
    expect(await readFile(join(final, 'checkout-hook.txt'), 'utf8')).toBe('checkout\n')
  } finally {
    settle()
    releasePreparationClaim(claim)
  }
})
