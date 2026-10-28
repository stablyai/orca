import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { trackGitWorktreeMutation } from './git-worktree-mutation-state'
import { tryAcquireConditionalWorktreeRemoval } from '../ipc/conditional-worktree-removal-lease'

let root = '',
  checkout = '',
  elsewhere = '',
  admin = ''
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-conditional-git-routing-')))
  checkout = join(root, 'checkout')
  elsewhere = join(root, 'elsewhere')
  admin = join(root, 'admin')
  for (const path of [checkout, elsewhere, admin]) {
    await mkdir(path)
  }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const routes = [
  'git-dir-separated',
  'git-dir-inline',
  'work-tree-separated',
  'work-tree-inline',
  'relative-git-dir',
  'relative-work-tree',
  'relative-cwd',
  'environment-git-dir',
  'environment-work-tree'
] as const
function routed(kind: (typeof routes)[number]) {
  const options: { cwd: string; env: NodeJS.ProcessEnv } = { cwd: elsewhere, env: {} }
  let prefix: string[] = []
  switch (kind) {
    case 'git-dir-separated':
      prefix = ['--git-dir', admin]
      break
    case 'git-dir-inline':
      prefix = [`--git-dir=${admin}`]
      break
    case 'work-tree-separated':
      prefix = ['--work-tree', checkout]
      break
    case 'work-tree-inline':
      prefix = [`--work-tree=${checkout}`]
      break
    case 'relative-git-dir':
      prefix = ['--git-dir', relative(elsewhere, admin)]
      break
    case 'relative-work-tree':
      prefix = [`--work-tree=${relative(elsewhere, checkout)}`]
      break
    case 'relative-cwd':
      prefix = ['-C', relative(elsewhere, checkout)]
      break
    case 'environment-git-dir':
      options.env = { GIT_DIR: admin }
      break
    case 'environment-work-tree':
      options.env = { GIT_WORK_TREE: checkout, GIT_DIR: admin }
      break
  }
  return { args: [...prefix, 'rebase', '--continue'], options }
}

describe('conditional removal and routed Git mutation admission', () => {
  it.each(routes)('refuses removal behind prior %s mutation without cancelling it', (kind) => {
    const { args, options } = routed(kind)
    const release = trackGitWorktreeMutation(args, options)
    try {
      expect(tryAcquireConditionalWorktreeRemoval(checkout)).toEqual({ kind: 'busy' })
    } finally {
      release()
    }
    const lease = tryAcquireConditionalWorktreeRemoval(checkout)
    if (lease.kind !== 'acquired') {
      throw new Error('expected lease')
    }
    lease.release()
  })

  it.each(routes)('refuses later %s mutation before it starts', (kind) => {
    const { args, options } = routed(kind)
    const lease = tryAcquireConditionalWorktreeRemoval(checkout)
    if (lease.kind !== 'acquired') {
      throw new Error('expected lease')
    }
    try {
      expect(() => trackGitWorktreeMutation(args, options)).toThrow('removal is in progress')
    } finally {
      lease.release()
    }
    const release = trackGitWorktreeMutation(args, options)
    release()
  })

  it('requires the exact active opaque token and admits only one conditional removal', () => {
    const lease = tryAcquireConditionalWorktreeRemoval(checkout)
    if (lease.kind !== 'acquired') {
      throw new Error('expected lease')
    }
    try {
      expect(tryAcquireConditionalWorktreeRemoval(elsewhere)).toEqual({ kind: 'busy' })
      expect(() =>
        trackGitWorktreeMutation(['update-ref', 'refs/fixture', 'HEAD'], {
          cwd: elsewhere,
          conditionalRemovalToken: Symbol('forged')
        })
      ).toThrow('removal is in progress')
      const release = trackGitWorktreeMutation(['update-ref', 'refs/fixture', 'HEAD'], {
        cwd: elsewhere,
        conditionalRemovalToken: lease.token
      })
      release()
      const read = trackGitWorktreeMutation(['--git-dir', admin, 'status', '--porcelain'], {
        cwd: elsewhere
      })
      read()
    } finally {
      lease.release()
    }
    const replacement = tryAcquireConditionalWorktreeRemoval(checkout)
    if (replacement.kind !== 'acquired') {
      throw new Error('expected lease')
    }
    try {
      expect(() =>
        trackGitWorktreeMutation(['reset', '--hard'], {
          cwd: elsewhere,
          conditionalRemovalToken: lease.token
        })
      ).toThrow('removal is in progress')
    } finally {
      replacement.release()
    }
  })
})
