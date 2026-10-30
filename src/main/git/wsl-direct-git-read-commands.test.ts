import { describe, expect, it } from 'vitest'
import { classifyGitCommand, isWslDirectGitReadCommand } from './wsl-direct-git-read-commands'

describe('isWslDirectGitReadCommand', () => {
  it.each([
    [['status', '--porcelain=v2']],
    [['log', '--oneline', '-n', '10']],
    [['show', ':src/file.ts']],
    [['show', '--end-of-options', 'HEAD:src/file.ts']],
    [['rev-parse', '--show-toplevel']],
    [['ls-files', '-z', '--', 'src']],
    [['check-ignore', '-z', '--stdin']],
    [['config', '--get', 'core.sshCommand']],
    [['config', '--get-regexp', String.raw`^remote\.`]],
    [['remote', 'get-url', 'origin']],
    [['remote']],
    [['remote', '-v']],
    [['remote', 'show', '-n', 'origin']],
    [['symbolic-ref', '--quiet', '--short', 'HEAD']],
    [['worktree', 'list', '--porcelain']],
    [['branch', '--list']],
    [['branch', '--show-current']],
    [['-c', 'core.quotepath=off', 'log', '--oneline']],
    [['-C', '/repo', 'rev-parse', 'HEAD']],
    [['--git-dir=/repo/.git', 'ls-tree', 'HEAD']],
    [['--git-dir', '/repo/.git', 'log']],
    [['--work-tree', '/repo', 'status']]
  ])('routes %j without a shell', (args) => {
    expect(isWslDirectGitReadCommand(args)).toBe(true)
  })

  // Writes need credential helpers and ssh-agent from the login shell.
  it.each([
    [['commit', '-m', 'msg']],
    [['push', 'origin', 'main']],
    [['fetch', '--all']],
    [['pull', '--rebase']],
    [['clone', 'https://example.com/r.git']],
    [['checkout', '-b', 'feature']],
    [['add', '--', 'file.ts']],
    [['worktree', 'add', '/tmp/wt']],
    [['submodule', 'update', '--init']],
    [['config', 'user.email', 'me@example.com']],
    [['config', '--unset', 'core.sshCommand']],
    [['remote', 'add', 'origin', 'https://example.com/r.git']],
    [['remote', 'remove', 'origin']],
    [['remote', 'show', 'origin']],
    [['symbolic-ref', 'HEAD', 'refs/heads/main']],
    [['worktree', 'add', '/tmp/wt']],
    [['branch', '-D', 'feature']],
    [['branch', '-r', '-d', 'origin/feature']],
    [['branch', '-rd', 'origin/feature']],
    [['branch', 'newbranch']],
    [[]]
  ])('keeps %j on the login shell', (args) => {
    expect(isWslDirectGitReadCommand(args)).toBe(false)
  })

  // Read markers count only in the action position; positional arguments can have the same names.
  it.each([[['worktree', 'remove', 'list']], [['submodule', 'foreach', 'status']]])(
    'keeps %j on the login shell despite a read-shaped positional',
    (args) => {
      expect(isWslDirectGitReadCommand(args)).toBe(false)
    }
  )

  it.each([[['submodule', 'status']], [['submodule']], [['remote']]])(
    'routes the listing form %j without a shell',
    (args) => {
      expect(isWslDirectGitReadCommand(args)).toBe(true)
    }
  )

  // Unparsed global options must fall back to the login shell rather than risk misrouting a write.
  it.each([
    [['-c', 'k=v', 'push', 'origin', 'main']],
    [['-C', '/repo', 'commit', '-m', 'x']],
    [['-c', 'k=v', 'fetch', '--all']],
    [['--git-dir=/x', 'push']],
    [['--git-dir', '/x', 'push']],
    [['--work-tree', '/x', 'commit', '-m', 'x']],
    [['-c', 'k=v']]
  ])('keeps %j on the login shell behind global options', (args) => {
    expect(isWslDirectGitReadCommand(args)).toBe(false)
  })
})

describe('classifyGitCommand', () => {
  it.each([
    [['fetch', '--all'], 'network'],
    [['pull', '--rebase'], 'network'],
    [['push', 'origin', 'main'], 'network'],
    [['clone', 'https://example.com/repo.git'], 'network'],
    [['ls-remote', '--heads', 'origin'], 'network'],
    [['submodule', 'update', '--init'], 'network'],
    [['remote', 'update', '--prune'], 'network'],
    [['-c', 'maintenance.auto=false', 'fetch', '--all'], 'network'],
    [['-C', '/repo', 'status', '--porcelain=v2'], 'read'],
    [['status', '--porcelain=v2'], 'read'],
    [['branch', '--show-current'], 'read'],
    [['branch', '-r', '-d', 'origin/feature'], 'other'],
    [['branch', '-rd', 'origin/feature'], 'other'],
    [['remote', 'get-url', 'origin'], 'read'],
    [['config', '--get-regexp', String.raw`^remote\.`], 'read'],
    [['show', '--end-of-options', 'HEAD:file'], 'read'],
    [['blame', '--', 'file'], 'read'],
    [['submodule', 'status'], 'read'],
    [['submodule', 'sync'], 'other'],
    [['submodule', 'foreach', 'status'], 'other'],
    [['remote', 'show', 'origin'], 'other'],
    [['remote', 'add', 'origin', 'url'], 'other'],
    [['checkout', 'main'], 'other'],
    [['made-up-command'], 'other'],
    [[], 'other'],
    [['--git-dir', '/repo/.git', 'log'], 'read'],
    [['--work-tree', '/repo', 'status'], 'read'],
    [['--git-dir', '/repo/.git', 'fetch', 'origin'], 'network'],
    [['-c', 'key=value'], 'other']
  ] as const)('classifies %j as %s', (args, expected) => {
    expect(classifyGitCommand(args)).toBe(expected)
  })

  it.each([
    [['--version'], 'other'],
    [['branch', '-a'], 'read'],
    [['branch', '--show-current'], 'read'],
    [['check-ref-format', '--branch', 'topic'], 'read'],
    [['checkout', 'topic'], 'other'],
    [['commit', '-m', 'message'], 'other'],
    [['config', '--get', 'remote.origin.url'], 'read'],
    [['config', '--local', 'key', 'value'], 'other'],
    [['diff', '--numstat', 'HEAD'], 'read'],
    [['fetch', '--prune'], 'network'],
    [['init'], 'other'],
    [['ls-files', '-z'], 'read'],
    [['ls-tree', 'HEAD'], 'read'],
    [['merge', '--abort'], 'other'],
    [['merge-base', 'HEAD', 'origin/main'], 'read'],
    [['pull', '--rebase'], 'network'],
    [['rebase', '--abort'], 'other'],
    [['remote'], 'read'],
    [['remote', '-v'], 'read'],
    [['remote', 'get-url', 'origin'], 'read'],
    [['restore', '--staged', '--', 'file'], 'other'],
    [['rev-list', '--count', 'HEAD'], 'read'],
    [['rev-parse', 'HEAD'], 'read'],
    [['show', ':file'], 'read'],
    [['status', '--porcelain=v2'], 'read'],
    [['update-ref', '-d', 'refs/orca/tmp'], 'other'],
    [['worktree', 'list', '--porcelain'], 'read'],
    [['worktree', 'prune'], 'other']
  ] as const)('covers the production form %j as %s', (args, expected) => {
    expect(classifyGitCommand(args)).toBe(expected)
  })
})
