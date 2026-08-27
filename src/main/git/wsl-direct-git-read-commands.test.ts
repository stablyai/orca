import { describe, expect, it } from 'vitest'
import { isWslDirectGitReadCommand } from './wsl-direct-git-read-commands'

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
    // Global options precede the subcommand.
    [['-c', 'core.quotepath=off', 'log', '--oneline']],
    [['-C', '/repo', 'rev-parse', 'HEAD']],
    [['--git-dir=/repo/.git', 'ls-tree', 'HEAD']]
  ])('routes %j without a shell', (args) => {
    expect(isWslDirectGitReadCommand(args)).toBe(true)
  })

  // Why these matter most: a write misrouted to the shell-free path loses the
  // credential helpers and ssh-agent the user's login shell sets up.
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
    // Same subcommands as above, in their writing form.
    [['config', 'user.email', 'me@example.com']],
    [['config', '--unset', 'core.sshCommand']],
    [['remote', 'add', 'origin', 'https://example.com/r.git']],
    [['remote', 'remove', 'origin']],
    [['remote', 'show', 'origin']],
    [['symbolic-ref', 'HEAD', 'refs/heads/main']],
    [['worktree', 'add', '/tmp/wt']],
    [['branch', '-D', 'feature']],
    [['branch', 'newbranch']],
    [[]]
  ])('keeps %j on the login shell', (args) => {
    expect(isWslDirectGitReadCommand(args)).toBe(false)
  })

  // Why positional: these read markers are matched as the action, not anywhere in
  // argv. Matching loosely routed a write shell-free whenever a positional
  // happened to share a read marker's name.
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

  // Why: a write hidden behind global options must never reach the shell-free
  // route, and an unparsed global form must fall back to the login shell rather
  // than guess. Both directions fail safe.
  it.each([
    [['-c', 'k=v', 'push', 'origin', 'main']],
    [['-C', '/repo', 'commit', '-m', 'x']],
    [['-c', 'k=v', 'fetch', '--all']],
    [['--git-dir=/x', 'push']],
    // Space-separated global values are not parsed; the value reads as the
    // subcommand, which is in no read set, so it stays on the login shell.
    [['--git-dir', '/x', 'log']],
    [['--work-tree', '/x', 'status']],
    [['-c', 'k=v']]
  ])('keeps %j on the login shell behind global options', (args) => {
    expect(isWslDirectGitReadCommand(args)).toBe(false)
  })
})
