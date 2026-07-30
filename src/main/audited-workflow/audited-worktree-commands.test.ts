import { describe, expect, it } from 'vitest'
import {
  assertAuditedGitArgvShape,
  buildRevParseCommitArgv,
  buildWorktreeAddArgv,
  buildWorktreeListArgv,
  findGitSubcommand,
  isReadOnlyAuditedArgv
} from './audited-worktree-commands'

describe('findGitSubcommand', () => {
  it('skips value-taking global options by arity', () => {
    expect(findGitSubcommand(['-c', 'gc.auto=0', 'worktree', 'add'])).toBe('worktree')
    expect(findGitSubcommand(['-C', '/repo', 'rev-parse', 'HEAD'])).toBe('rev-parse')
  })

  it('skips attached-form globals', () => {
    expect(findGitSubcommand(['--git-dir=/x/.git', 'symbolic-ref', 'HEAD'])).toBe('symbolic-ref')
  })

  it('returns null when there is no subcommand', () => {
    expect(findGitSubcommand(['-c', 'gc.auto=0'])).toBeNull()
  })
})

describe('assertAuditedGitArgvShape', () => {
  it('accepts the single mutating shape', () => {
    expect(() =>
      assertAuditedGitArgvShape(buildWorktreeAddArgv('orca/audited/t', '/wt', 'a'.repeat(40)))
    ).not.toThrow()
  })

  it('accepts the read-only shapes', () => {
    expect(() => assertAuditedGitArgvShape(buildWorktreeListArgv())).not.toThrow()
    expect(() => assertAuditedGitArgvShape(buildRevParseCommitArgv('HEAD'))).not.toThrow()
  })

  it.each([
    ['fetch', ['fetch', 'origin']],
    ['pull', ['pull']],
    ['push', ['push', 'origin', 'main']],
    ['clone', ['clone', 'url']],
    ['ls-remote', ['ls-remote', 'origin']],
    ['remote', ['remote', 'update']],
    ['submodule', ['submodule', 'update', '--remote']]
  ])('rejects the network subcommand %s', (_label, argv) => {
    expect(() => assertAuditedGitArgvShape(argv)).toThrow(/disallowed git subcommand/)
  })

  it.each([['remove'], ['prune'], ['repair'], ['move']])(
    'rejects the destructive worktree verb %s',
    (verb) => {
      expect(() => assertAuditedGitArgvShape(['worktree', verb])).toThrow(
        /disallowed worktree verb/
      )
    }
  )

  it('rejects -B, which would reset an existing branch', () => {
    expect(() =>
      assertAuditedGitArgvShape(['worktree', 'add', '-B', 'branch', '/wt', 'a'.repeat(40)])
    ).toThrow(/-B is never permitted/)
  })

  it('detects a forbidden subcommand hidden behind global options', () => {
    expect(() => assertAuditedGitArgvShape(['-c', 'gc.auto=0', 'fetch'])).toThrow(
      /disallowed git subcommand/
    )
  })

  // The screen is structural, not a substring blacklist: operand CONTENT is
  // irrelevant, so a repo living at .../my-remote-fetch-push/... still works.
  it('accepts operands whose text contains remote/fetch/push', () => {
    const argv = buildWorktreeAddArgv(
      'orca/audited/push-fetch',
      '/tmp/my-remote-fetch-push/repo-wt',
      'b'.repeat(40)
    )
    expect(() => assertAuditedGitArgvShape(argv)).not.toThrow()
    expect(findGitSubcommand(argv)).toBe('worktree')
  })
})

describe('buildWorktreeAddArgv', () => {
  it('requires a full 40-hex OID so no ref resolution or prefetch can occur', () => {
    expect(() => buildWorktreeAddArgv('b', '/wt', 'main')).toThrow(/full 40-hex OID/)
    expect(() => buildWorktreeAddArgv('b', '/wt', 'abc')).toThrow(/full 40-hex OID/)
  })

  it('uses --no-track and -b, and suppresses auto-maintenance', () => {
    const argv = buildWorktreeAddArgv('orca/audited/t1', '/wt', 'c'.repeat(40))
    expect(argv).toEqual([
      '-c',
      'maintenance.auto=false',
      '-c',
      'gc.auto=0',
      'worktree',
      'add',
      '--no-track',
      '-b',
      'orca/audited/t1',
      '/wt',
      'c'.repeat(40)
    ])
  })
})

describe('isReadOnlyAuditedArgv', () => {
  it('classifies worktree add as mutating and worktree list as read-only', () => {
    expect(isReadOnlyAuditedArgv(buildWorktreeAddArgv('b', '/wt', 'd'.repeat(40)))).toBe(false)
    expect(isReadOnlyAuditedArgv(buildWorktreeListArgv())).toBe(true)
  })
})
