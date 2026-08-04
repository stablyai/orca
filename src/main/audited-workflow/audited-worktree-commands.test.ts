import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  assertAuditedGitArgvShape,
  assertCandidateIsolation,
  buildCandidateAddArgv,
  buildReadTreeArgv,
  buildRevParseCommitArgv,
  buildWorktreeAddArgv,
  buildWorktreeListArgv,
  buildWriteTreeArgv,
  findGitSubcommand,
  isReadOnlyAuditedArgv,
  runAuditedGitRead,
  type CandidateIsolationBounds,
  type CandidateIsolationEnv
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

  // Phase 7: these create objects, so they must never be classified read-only —
  // the read path sets no GIT_OBJECT_DIRECTORY and would write to the real store.
  it('classifies every candidate command as NOT read-only', () => {
    expect(isReadOnlyAuditedArgv(buildReadTreeArgv('a'.repeat(40)))).toBe(false)
    expect(isReadOnlyAuditedArgv(buildCandidateAddArgv())).toBe(false)
    expect(isReadOnlyAuditedArgv(buildWriteTreeArgv())).toBe(false)
  })

  it('refuses to run a candidate command through the read path', async () => {
    await expect(runAuditedGitRead(buildWriteTreeArgv(), tmpdir())).rejects.toThrow(
      /must use runAuditedGitCandidateWrite/
    )
  })
})

// C7 / C8. The isolation is enforced at the spawn boundary, so every way of
// weakening it is a throw rather than a silently degraded spawn.
describe('assertCandidateIsolation', () => {
  const candidateDir = join(tmpdir(), 'orca-cand', 'exec_1')
  const bounds: CandidateIsolationBounds = {
    candidateDir,
    worktreePath: join(tmpdir(), 'orca-wt'),
    commonObjectDir: join(tmpdir(), 'orca-repo', '.git', 'objects')
  }
  const env: CandidateIsolationEnv = {
    gitIndexFile: join(candidateDir, 'index.tmp'),
    gitObjectDirectory: join(candidateDir, 'objects'),
    gitAlternateObjectDirectories: bounds.commonObjectDir
  }

  it('accepts a fully isolated invocation', () => {
    expect(() => assertCandidateIsolation(buildWriteTreeArgv(), env, bounds)).not.toThrow()
  })

  // The single most important refusal: a missing object dir is exactly the bug
  // that silently persists untracked bytes into the user's repository.
  it.each([
    ['GIT_OBJECT_DIRECTORY', { gitObjectDirectory: '' }],
    ['GIT_INDEX_FILE', { gitIndexFile: '' }],
    ['GIT_ALTERNATE_OBJECT_DIRECTORIES', { gitAlternateObjectDirectories: '' }]
  ])('refuses when %s is missing', (_label, overrides) => {
    expect(() =>
      assertCandidateIsolation(buildWriteTreeArgv(), { ...env, ...overrides }, bounds)
    ).toThrow(/require GIT_INDEX_FILE/)
  })

  it('refuses an object dir outside the per-run candidate dir', () => {
    expect(() =>
      assertCandidateIsolation(
        buildWriteTreeArgv(),
        { ...env, gitObjectDirectory: join(tmpdir(), 'elsewhere') },
        bounds
      )
    ).toThrow(/must live inside the per-run candidate dir/)
  })

  // A candidate dir that was itself misconfigured to sit inside the worktree:
  // containment in the candidate dir passes, so the worktree check is what
  // catches it.
  it('refuses a temp path inside the audited worktree', () => {
    const insideWorktree = join(bounds.worktreePath, 'candidates', 'exec_1')
    expect(() =>
      assertCandidateIsolation(
        buildWriteTreeArgv(),
        {
          ...env,
          gitIndexFile: join(insideWorktree, 'index.tmp'),
          gitObjectDirectory: join(insideWorktree, 'objects')
        },
        { ...bounds, candidateDir: insideWorktree }
      )
    ).toThrow(/must not live inside the audited worktree/)
  })

  it('refuses a multi-entry alternate', () => {
    const separator = process.platform === 'win32' ? ';' : ':'
    expect(() =>
      assertCandidateIsolation(
        buildWriteTreeArgv(),
        {
          ...env,
          gitAlternateObjectDirectories: `${bounds.commonObjectDir}${separator}${tmpdir()}`
        },
        bounds
      )
    ).toThrow(/exactly one entry/)
  })

  it('refuses an alternate that is not the repository object dir', () => {
    expect(() =>
      assertCandidateIsolation(
        buildWriteTreeArgv(),
        { ...env, gitAlternateObjectDirectories: join(tmpdir(), 'other', 'objects') },
        bounds
      )
    ).toThrow(/must be the repository common object dir/)
  })

  it.each([
    ['--index-file', ['write-tree', '--index-file=/tmp/x']],
    ['-C', ['-C', '/elsewhere', 'write-tree']],
    ['--work-tree', ['write-tree', '--work-tree=/elsewhere']],
    ['--git-dir', ['write-tree', '--git-dir=/elsewhere']],
    ['--namespace', ['write-tree', '--namespace=ns']]
  ])('refuses %s, which would defeat the env', (_label, argv) => {
    expect(() => assertCandidateIsolation(argv, env, bounds)).toThrow(/never permitted/)
  })

  it('refuses an add carrying a pathspec', () => {
    expect(() => assertCandidateIsolation(['add', '-A', '--', 'src/'], env, bounds)).toThrow(
      /exactly `add -A --`/
    )
    expect(() => assertCandidateIsolation(['add', '-A'], env, bounds)).toThrow(
      /exactly `add -A --`/
    )
  })
})
