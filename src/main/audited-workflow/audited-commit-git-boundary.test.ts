// Phase 8 — the structural screen on commit-path Git commands.
//
// The two policies asserted here are INVERSES and must never be confused:
//   candidate writes REQUIRE a temp object dir (leave no trace)
//   commit writes FORBID one            (the commit must persist)
import { describe, expect, it } from 'vitest'
import {
  assertCandidateStoreReadShape,
  assertCommitWriteIsolation,
  assertCandidateIsolation,
  buildCommitTreeArgv,
  buildPackObjectsStdoutArgv,
  buildReadTreeRefreshArgv,
  buildRevListObjectsArgv,
  buildUpdateRefCasArgv,
  isReadOnlyAuditedArgv,
  runAuditedGitCommitWrite,
  runAuditedGitRead,
  AuditedGitCommandShapeError
} from './audited-worktree-commands'

const OID_A = 'a'.repeat(40)
const OID_B = 'b'.repeat(40)
const OID_C = 'c'.repeat(40)

describe('commit-path git boundary', () => {
  it('builds the three-operand update-ref CAS', () => {
    expect(buildUpdateRefCasArgv('br', OID_A, OID_B)).toEqual([
      'update-ref',
      'refs/heads/br',
      OID_A,
      OID_B
    ])
  })

  it('rejects a two-operand update-ref (a blind overwrite)', () => {
    expect(() =>
      assertCommitWriteIsolation(['update-ref', 'refs/heads/br', OID_A], undefined)
    ).toThrow(AuditedGitCommandShapeError)
  })

  it.each([['-d'], ['--stdin']])('rejects update-ref %s', (flag) => {
    expect(() =>
      assertCommitWriteIsolation(['update-ref', flag, 'refs/heads/br', OID_A], undefined)
    ).toThrow(AuditedGitCommandShapeError)
  })

  it('rejects a read-tree with a tree-ish operand on the commit path', () => {
    expect(() => assertCommitWriteIsolation(['read-tree', OID_A], undefined)).toThrow(
      AuditedGitCommandShapeError
    )
    expect(() => assertCommitWriteIsolation(buildReadTreeRefreshArgv(), undefined)).not.toThrow()
  })

  it.each([['--index-file'], ['-C'], ['--work-tree'], ['--git-dir'], ['--namespace']])(
    'rejects %s on a commit command',
    (option) => {
      expect(() =>
        assertCommitWriteIsolation([option, '/tmp/x', 'commit-tree', OID_A], undefined)
      ).toThrow(AuditedGitCommandShapeError)
    }
  )

  // The inverse-policy assertion: a redirected object dir would mean the commit
  // does not persist.
  it('rejects a commit command when GIT_OBJECT_DIRECTORY is set', () => {
    expect(() =>
      assertCommitWriteIsolation(buildReadTreeRefreshArgv(), {
        GIT_OBJECT_DIRECTORY: '/tmp/objects'
      })
    ).toThrow(AuditedGitCommandShapeError)
    expect(() =>
      assertCommitWriteIsolation(buildReadTreeRefreshArgv(), {
        GIT_ALTERNATE_OBJECT_DIRECTORIES: '/tmp/objects'
      })
    ).toThrow(AuditedGitCommandShapeError)
  })

  // ...and the candidate path still REQUIRES one, so the two cannot be swapped.
  it('still requires a temp object dir on the candidate path', () => {
    expect(() =>
      assertCandidateIsolation(
        ['write-tree'],
        {
          gitIndexFile: '/tmp/run/index.tmp',
          gitObjectDirectory: '',
          gitAlternateObjectDirectories: '/repo/.git/objects'
        },
        {
          candidateDir: '/tmp/run',
          worktreePath: '/wt',
          commonObjectDir: '/repo/.git/objects'
        }
      )
    ).toThrow(AuditedGitCommandShapeError)
  })

  it('refuses worktree-hashing commands on the commit path', async () => {
    await expect(runAuditedGitCommitWrite(['add', '-A', '--'], '/tmp')).rejects.toThrow(
      AuditedGitCommandShapeError
    )
    await expect(runAuditedGitCommitWrite(['write-tree'], '/tmp')).rejects.toThrow(
      AuditedGitCommandShapeError
    )
  })

  it('refuses commit-path commands through the read path', async () => {
    await expect(
      runAuditedGitRead(buildCommitTreeArgv(OID_A, OID_B, '/tmp/msg'), '/tmp')
    ).rejects.toThrow(AuditedGitCommandShapeError)
    await expect(
      runAuditedGitRead(buildUpdateRefCasArgv('br', OID_A, OID_B), '/tmp')
    ).rejects.toThrow(AuditedGitCommandShapeError)
  })

  it('marks the new object-writing subcommands as non-read-only', () => {
    expect(isReadOnlyAuditedArgv(buildCommitTreeArgv(OID_A, OID_B, '/tmp/m'))).toBe(false)
    expect(isReadOnlyAuditedArgv(buildUpdateRefCasArgv('br', OID_A, OID_B))).toBe(false)
    expect(isReadOnlyAuditedArgv(['unpack-objects'])).toBe(false)
    expect(isReadOnlyAuditedArgv(buildRevListObjectsArgv(OID_C))).toBe(false)
    expect(isReadOnlyAuditedArgv(buildPackObjectsStdoutArgv())).toBe(false)
    // Ordinary reads are unaffected.
    expect(isReadOnlyAuditedArgv(['rev-parse', '--verify', 'HEAD'])).toBe(true)
  })

  it('requires the candidate store dir for store reads', () => {
    expect(() => assertCandidateStoreReadShape(buildRevListObjectsArgv(OID_C), '')).toThrow(
      AuditedGitCommandShapeError
    )
    expect(() =>
      assertCandidateStoreReadShape(buildRevListObjectsArgv(OID_C), '/store')
    ).not.toThrow()
  })

  it('requires pack-objects to be --stdout so it can never write a pack', () => {
    expect(() => assertCandidateStoreReadShape(['pack-objects', '/tmp/out'], '/store')).toThrow(
      AuditedGitCommandShapeError
    )
  })

  it('rejects non-OID operands in the builders', () => {
    expect(() => buildCommitTreeArgv('short', OID_B, '/tmp/m')).toThrow(AuditedGitCommandShapeError)
    expect(() => buildUpdateRefCasArgv('br', 'short', OID_B)).toThrow(AuditedGitCommandShapeError)
    expect(() => buildRevListObjectsArgv('short')).toThrow(AuditedGitCommandShapeError)
  })
})
