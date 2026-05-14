import { describe, expect, it } from 'vitest'
import { validateGitExecArgs } from './git-exec-validator'

function expectAllowed(args: string[]): void {
  expect(() => validateGitExecArgs(args)).not.toThrow()
}

function expectBlocked(args: string[], message: string): void {
  expect(() => validateGitExecArgs(args)).toThrow(message)
}

describe('validateGitExecArgs', () => {
  describe('allowed read-only subcommands', () => {
    it.each([
      [['rev-parse', '--show-toplevel']],
      [['branch', '--list']],
      [['log', '--oneline', '-10']],
      [['show-ref', '--heads']],
      [['ls-remote', 'origin']],
      [['remote', '-v']],
      [['remote', 'get-url', 'origin']],
      [['remote', 'show', 'origin']],
      [['symbolic-ref', 'HEAD']],
      [['symbolic-ref', '--short', 'HEAD']],
      [['merge-base', 'main', 'HEAD']],
      [['ls-files', '--error-unmatch', 'foo.txt']],
      [['config', '--get', 'user.name']],
      [['config', '--get-all', 'remote.origin.url']],
      [['config', '--list']],
      [['config', '-l']],
      [['config', '--get-regexp', 'user']],
      [['for-each-ref', '--format=%(refname)', 'refs/remotes']],
      [
        [
          'for-each-ref',
          '--format=%(refname)%00%(refname:short)',
          '--sort=-committerdate',
          'refs/heads/*foo*'
        ]
      ]
    ])('allows %j', (args) => {
      expectAllowed(args)
    })
  })

  describe('blocked subcommands', () => {
    it('rejects empty args', () => {
      expectBlocked([], 'git subcommand not allowed: (empty)')
    })

    it.each([
      'push',
      'pull',
      'commit',
      'checkout',
      'reset',
      'rebase',
      'merge',
      'stash',
      'clean',
      'gc',
      'reflog',
      'tag',
      'fetch',
      'worktree'
    ])('rejects %s', (cmd) => {
      expectBlocked([cmd], 'git subcommand not allowed')
    })
  })

  describe('global flags before subcommand', () => {
    it.each([
      [['-c', 'core.sshCommand=evil', 'log']],
      [['--no-pager', 'log']],
      [['-C', '/tmp', 'status']]
    ])('rejects %j', (args) => {
      expectBlocked(args, 'Global git flags before the subcommand are not allowed')
    })
  })

  describe('global denied flags', () => {
    it.each([
      [['log', '--output', '/tmp/leak']],
      [['log', '--output=/tmp/leak']],
      [['log', '-o', '/tmp/leak']],
      [['rev-parse', '--exec-path=/evil']],
      [['log', '--work-tree=/other']],
      [['log', '--git-dir=/other/.git']],
      // Pin global-deny coverage on for-each-ref so a future allowlist
      // refactor that bypassed GLOBAL_DENIED_FLAGS for this subcommand fails
      // loudly. The first round of for-each-ref enablement omitted these.
      [['for-each-ref', '--git-dir=/other/.git', '--format=%(refname)']],
      [['for-each-ref', '--output=/tmp/leak', '--format=%(refname)']],
      [['for-each-ref', '--work-tree=/other']]
    ])('rejects %j', (args) => {
      expectBlocked(args, 'Dangerous git flags are not allowed')
    })

    it('does not false-positive on unrelated =value flags', () => {
      expectAllowed(['log', '--format=%H'])
      expectAllowed(['log', '--pretty=oneline'])
    })
  })

  describe('git config', () => {
    it('rejects config without read-only flag', () => {
      expectBlocked(['config', 'user.name', 'Evil'], 'restricted to read-only operations')
    })

    it.each([
      ['--add'],
      ['--unset'],
      ['--unset-all'],
      ['--replace-all'],
      ['--rename-section'],
      ['--remove-section'],
      ['--edit'],
      ['-e'],
      ['--file=/etc/passwd'],
      ['-f'],
      ['--global'],
      ['--system']
    ])('rejects config with write flag %s', (flag) => {
      expectBlocked(
        ['config', '--list', flag, 'val'],
        'git config write operations are not allowed'
      )
    })
  })

  describe('git branch', () => {
    it('allows safe branch flags', () => {
      expectAllowed(['branch', '--list'])
      expectAllowed(['branch', '-a'])
      expectAllowed(['branch', '-r'])
    })

    it.each(['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy'])(
      'rejects branch %s',
      (flag) => {
        expectBlocked(['branch', flag, 'name'], 'Destructive git branch flags')
      }
    )

    it('catches --delete=value compound syntax', () => {
      expectBlocked(['branch', '--delete=feature'], 'Destructive git branch flags')
    })
  })

  describe('git remote', () => {
    it.each([
      'add',
      'remove',
      'rm',
      'rename',
      'set-url',
      'set-head',
      'set-branches',
      'prune',
      'update'
    ])('rejects remote %s', (subcmd) => {
      expectBlocked(['remote', subcmd, 'arg'], 'Destructive git remote operations')
    })

    it('skips flags when finding remote subcommand', () => {
      expectBlocked(['remote', '-v', 'add', 'evil', 'url'], 'Destructive git remote operations')
    })
  })

  describe('git symbolic-ref', () => {
    it('allows read operations', () => {
      expectAllowed(['symbolic-ref', 'HEAD'])
      expectAllowed(['symbolic-ref', '--short', 'HEAD'])
      expectAllowed(['symbolic-ref', '-q', 'HEAD'])
    })

    it.each(['-d', '--delete', '-m'])('rejects symbolic-ref %s', (flag) => {
      expectBlocked(['symbolic-ref', flag, 'HEAD'], 'git symbolic-ref write operations')
    })

    it('rejects two positional args (write form)', () => {
      expectBlocked(
        ['symbolic-ref', 'HEAD', 'refs/heads/main'],
        'git symbolic-ref write operations'
      )
    })

    it('catches --delete=value compound syntax', () => {
      expectBlocked(['symbolic-ref', '--delete=HEAD'], 'git symbolic-ref write operations')
    })
  })
})
