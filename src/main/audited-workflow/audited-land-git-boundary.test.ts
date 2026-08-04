// Phase 10 boundary proofs. These assert STRUCTURAL properties: they drive
// assertLandWriteIsolation with hand-built argv, because the guarantees must hold
// for any argv, not merely for what the builders happen to produce.
//
// THE INVERSION THIS FILE EXISTS TO PIN: every other audited Git path runs inside
// the managed worktree. The land path runs inside the user's SOURCE repository and
// must refuse to spawn against an audited worktree at all.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertLandWriteIsolation,
  buildDiffIndexQuietArgv,
  buildLandReadTreeArgv,
  buildStatusPorcelainArgv,
  runAuditedGitLandWrite
} from './audited-land-commands'
import {
  assertAuditedGitArgvShape,
  buildRevListCountArgv,
  buildUpdateRefCasArgv,
  isReadOnlyAuditedArgv
} from './audited-worktree-commands'

vi.mock('./audited-worktree-registry', () => ({
  isAuditedWorktreePath: (p: string) => p.includes('AUDITED'),
  isAuditedWorktreeRegistryReady: () => registryReady
}))

let registryReady = true
afterEach(() => {
  registryReady = true
})

const BASE = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const SOURCE = '/home/u/repo'
const AUDITED = '/home/u/AUDITED/wt'

describe('land read-tree shape — exactly `read-tree -m -u <oid> <oid>`', () => {
  it('accepts the canonical form', () => {
    const argv = buildLandReadTreeArgv(BASE, NEW)
    expect(argv).toEqual(['read-tree', '-m', '-u', BASE, NEW])
    expect(() => assertLandWriteIsolation(argv, {}, SOURCE)).not.toThrow()
  })

  it('rejects the Phase 8 commit-path form `read-tree HEAD`', () => {
    expect(() => assertLandWriteIsolation(['read-tree', 'HEAD'], {}, SOURCE)).toThrow(
      /read-tree -m -u/
    )
  })

  it.each([
    ['missing -u', ['read-tree', '-m', BASE, NEW]],
    ['missing -m', ['read-tree', '-u', BASE, NEW]],
    ['reset form', ['read-tree', '--reset', '-u', BASE, NEW]],
    ['one operand', ['read-tree', '-m', '-u', BASE]],
    ['three operands', ['read-tree', '-m', '-u', BASE, NEW, NEW]],
    ['non-OID operand', ['read-tree', '-m', '-u', 'HEAD', NEW]],
    ['branch operand', ['read-tree', '-m', '-u', BASE, 'refs/heads/main']]
  ])('rejects %s', (_label, argv) => {
    expect(() => assertLandWriteIsolation(argv, {}, SOURCE)).toThrow(/read-tree -m -u/)
  })

  it('refuses to BUILD from a non-OID operand', () => {
    expect(() => buildLandReadTreeArgv('HEAD', NEW)).toThrow(/full 40-hex OID/)
    expect(() => buildLandReadTreeArgv(BASE, 'main')).toThrow(/full 40-hex OID/)
  })
})

describe('land update-ref shape — the three-operand CAS only', () => {
  it('accepts the canonical CAS form', () => {
    const argv = buildUpdateRefCasArgv('main', NEW, BASE)
    expect(argv).toEqual(['update-ref', 'refs/heads/main', NEW, BASE])
    expect(() => assertLandWriteIsolation(argv, {}, SOURCE)).not.toThrow()
  })

  it('rejects the two-operand blind overwrite', () => {
    expect(() =>
      assertLandWriteIsolation(['update-ref', 'refs/heads/main', NEW], {}, SOURCE)
    ).toThrow(/three-operand/)
  })

  it.each([['-d'], ['--stdin']])('rejects update-ref %s', (flag) => {
    expect(() =>
      assertLandWriteIsolation(['update-ref', flag, 'refs/heads/main', NEW, BASE], {}, SOURCE)
    ).toThrow(/never permitted/)
  })
})

describe('land env policy — the REAL object store, never a redirect', () => {
  it.each([['GIT_OBJECT_DIRECTORY'], ['GIT_ALTERNATE_OBJECT_DIRECTORIES']])(
    'rejects %s, which would redirect the object store',
    (key) => {
      expect(() =>
        assertLandWriteIsolation(buildLandReadTreeArgv(BASE, NEW), { [key]: '/tmp/o' }, SOURCE)
      ).toThrow(/must be unset/)
    }
  )

  it.each([['--git-dir'], ['--work-tree'], ['--namespace'], ['--index-file'], ['-C']])(
    'rejects %s, which would re-point Git',
    (option) => {
      const argv = ['update-ref', `${option}=/tmp/x`, 'refs/heads/main', NEW, BASE]
      expect(() => assertLandWriteIsolation(argv, {}, SOURCE)).toThrow(/re-point Git/)
    }
  )
})

describe('THE INVERSION — a land command never runs against an audited worktree', () => {
  it('refuses an audited worktree cwd', () => {
    expect(() => assertLandWriteIsolation(buildLandReadTreeArgv(BASE, NEW), {}, AUDITED)).toThrow(
      /never an audited worktree/
    )
  })

  it('refuses the ref update against an audited worktree too', () => {
    expect(() =>
      assertLandWriteIsolation(buildUpdateRefCasArgv('main', NEW, BASE), {}, AUDITED)
    ).toThrow(/never an audited worktree/)
  })

  it('FAILS CLOSED while the registry is still loading', () => {
    registryReady = false
    expect(() => assertLandWriteIsolation(buildLandReadTreeArgv(BASE, NEW), {}, SOURCE)).toThrow(
      /registry is ready/
    )
  })
})

describe('readiness probes are read-only and arity-screened', () => {
  it('accepts exactly `status --porcelain`', () => {
    const argv = buildStatusPorcelainArgv()
    expect(argv).toEqual(['status', '--porcelain'])
    expect(() => assertAuditedGitArgvShape(argv)).not.toThrow()
    expect(isReadOnlyAuditedArgv(argv)).toBe(true)
  })

  it.each([
    ['status with -uall', ['status', '--porcelain', '-uall']],
    ['status bare', ['status']],
    ['status with branch', ['status', '--porcelain=v2', '--branch']]
  ])('rejects %s', (_label, argv) => {
    expect(() => assertAuditedGitArgvShape(argv)).toThrow(/status --porcelain/)
  })

  it('accepts exactly `diff-index --quiet <tree-ish> --`', () => {
    const argv = buildDiffIndexQuietArgv('HEAD')
    expect(argv).toEqual(['diff-index', '--quiet', 'HEAD', '--'])
    expect(() => assertAuditedGitArgvShape(argv)).not.toThrow()
    expect(isReadOnlyAuditedArgv(argv)).toBe(true)
  })

  it.each([
    ['no trailing --', ['diff-index', '--quiet', 'HEAD']],
    ['a pathspec after --', ['diff-index', '--quiet', 'HEAD', '--', 'src']],
    ['not --quiet', ['diff-index', '--cached', 'HEAD', '--']]
  ])('rejects diff-index %s', (_label, argv) => {
    expect(() => assertAuditedGitArgvShape(argv)).toThrow(/diff-index --quiet/)
  })
})

describe('rev-list --count reaches the read path; --objects never does', () => {
  // REGRESSION. `rev-list` was blanket-excluded from the read path as a
  // candidate-store command, which silently broke Phase 8's descendantCount
  // evidence channel (audited-commit-evidence.ts) as well as Phase 10's tip
  // classification. The counting form resolves from the REAL store and needs no
  // GIT_OBJECT_DIRECTORY; only the enumerating form does.
  it('admits the counting form', () => {
    const argv = buildRevListCountArgv(BASE, NEW)
    expect(argv).toEqual(['rev-list', '--count', `${BASE}..${NEW}`])
    expect(isReadOnlyAuditedArgv(argv)).toBe(true)
  })

  it.each([
    ['--objects', ['rev-list', '--objects', '--no-object-names', BASE]],
    ['bare', ['rev-list', BASE]],
    ['count with extra operands', ['rev-list', '--count', BASE, NEW]],
    ['objects before count', ['rev-list', '--objects', '--count', BASE]]
  ])('keeps the %s form OFF the read path', (_label, argv) => {
    expect(isReadOnlyAuditedArgv(argv)).toBe(false)
  })
})

describe('land path admits only update-ref and read-tree', () => {
  // The SUBCOMMAND gate lives in runAuditedGitLandWrite, which screens against
  // LAND_WRITE_SUBCOMMANDS before it ever reaches the shape policy. Driving the
  // spawn function is therefore the only honest way to prove the gate — and it
  // throws before spawning, so no Git process is created.
  it.each([
    ['push', ['push', 'origin', 'main']],
    ['fetch', ['fetch', 'origin']],
    ['commit-tree', ['commit-tree', BASE]],
    ['unpack-objects', ['unpack-objects']],
    ['add', ['add', '-A', '--']],
    ['write-tree', ['write-tree']],
    ['status', ['status', '--porcelain']]
  ])('rejects %s on the land path', async (_label, argv) => {
    await expect(runAuditedGitLandWrite(argv, SOURCE)).rejects.toThrow(
      /only for land commands|disallowed/
    )
  })

  it('rejects a land command spawned against an audited worktree', async () => {
    await expect(runAuditedGitLandWrite(buildLandReadTreeArgv(BASE, NEW), AUDITED)).rejects.toThrow(
      /never an audited worktree/
    )
  })

  it('keeps the land WRITE commands off the read path', () => {
    expect(isReadOnlyAuditedArgv(buildLandReadTreeArgv(BASE, NEW))).toBe(false)
    expect(isReadOnlyAuditedArgv(buildUpdateRefCasArgv('main', NEW, BASE))).toBe(false)
  })
})
