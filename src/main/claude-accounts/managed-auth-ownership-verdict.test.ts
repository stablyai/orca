import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restorePlatform, setPlatform } from './claude-account-service-test-harness'
import type * as NodeFsModule from 'node:fs'
import type * as WslPathsModule from '../../shared/wsl-paths'

// Fault injection at the filesystem, so the classifier under test is the thing
// deciding what an errno means. Keyed by path suffix: the probe reads several
// paths and only one of them is meant to be locked.
const fsFaults = vi.hoisted(() => ({
  lockedReadSuffix: null as string | null,
  lockedLstatSuffix: null as string | null,
  hostileWriteSuffix: null as string | null
}))

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof NodeFsModule>()
  const locked = (path: unknown, suffix: string | null) =>
    suffix !== null && String(path).endsWith(suffix)
  const busy = (path: unknown, syscall: string) => {
    const error = new Error(
      `EBUSY: resource busy or locked, ${syscall} '${String(path)}'`
    ) as NodeJS.ErrnoException
    error.code = 'EBUSY'
    error.syscall = syscall
    return error
  }
  const readFileSync = ((path: never, options: never) => {
    if (locked(path, fsFaults.lockedReadSuffix)) {
      throw busy(path, 'read')
    }
    return original.readFileSync(path, options)
  }) as typeof original.readFileSync
  const lstatSync = ((path: never, options: never) => {
    if (locked(path, fsFaults.lockedLstatSuffix)) {
      throw busy(path, 'lstat')
    }
    return original.lstatSync(path, options)
  }) as typeof original.lstatSync
  const writeFileSync = ((path: never, data: never, options: never) => {
    if (locked(path, fsFaults.hostileWriteSuffix)) {
      // What a `catch` can actually receive: a value whose `code` accessor throws.
      throw {
        get code(): string {
          throw new Error('unreadable errno')
        }
      }
    }
    return original.writeFileSync(path, data, options)
  }) as typeof original.writeFileSync
  const mocked = { ...original, readFileSync, lstatSync, writeFileSync }
  return { ...mocked, default: mocked }
})

const paths = vi.hoisted(() => ({ userDataRoot: '' }))

vi.mock('electron', () => ({ app: { getPath: () => paths.userDataRoot } }))

// Makes a POSIX temp path addressable as a guest path, so the host-visible WSL
// branch can be exercised without a distro.
vi.mock('../../shared/wsl-paths', async (importOriginal) => {
  const original = await importOriginal<typeof WslPathsModule>()
  return {
    ...original,
    parseWslUncPath: (path: string) =>
      path.includes('/.local/share/orca/claude-accounts/')
        ? { distro: 'Ubuntu', linuxPath: path }
        : original.parseWslUncPath(path)
  }
})

vi.mock('./keychain', () => ({
  deleteManagedClaudeKeychainCredentials: vi.fn(async () => {}),
  readManagedClaudeKeychainCredentials: vi.fn(),
  writeManagedClaudeKeychainCredentials: vi.fn(async () => {})
}))

const { MANAGED_AUTH_MARKER, resolveClaudeManagedAuthVerdict } = await import('./managed-auth-path')
const { ClaudeManagedAuthStorage } = await import('./claude-managed-auth-storage')
const { MISSING_MANAGED_AUTH_MESSAGE, OUTSIDE_MANAGED_AUTH_ROOT_MESSAGE } =
  await import('./claude-managed-auth-ownership')

const ACCOUNT_ID = 'acct-5674'

function seedAccount(markerContents: string | null): string {
  const authPath = join(paths.userDataRoot, 'claude-accounts', ACCOUNT_ID, 'auth')
  mkdirSync(authPath, { recursive: true })
  if (markerContents !== null) {
    writeFileSync(join(authPath, MANAGED_AUTH_MARKER), markerContents)
  }
  return authPath
}

describe('host Claude managed-auth verdict', () => {
  beforeEach(() => {
    fsFaults.lockedReadSuffix = null
    fsFaults.lockedLstatSuffix = null
    fsFaults.hostileWriteSuffix = null
    paths.userDataRoot = mkdtempSync(join(tmpdir(), 'sta5674-verdict-'))
  })

  afterEach(() => {
    restorePlatform()
    fsFaults.lockedReadSuffix = null
    fsFaults.lockedLstatSuffix = null
    fsFaults.hostileWriteSuffix = null
    rmSync(paths.userDataRoot, { recursive: true, force: true })
  })

  it('accepts a directory whose marker names the account', () => {
    const authPath = seedAccount(`${ACCOUNT_ID}\n`)
    expect(resolveClaudeManagedAuthVerdict(ACCOUNT_ID, authPath)).toMatchObject({ kind: 'owned' })
  })

  it('refuses a symlinked candidate rather than following it', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'sta5674-elsewhere-'))
    writeFileSync(join(elsewhere, MANAGED_AUTH_MARKER), `${ACCOUNT_ID}\n`)
    const accountRoot = join(paths.userDataRoot, 'claude-accounts', ACCOUNT_ID)
    mkdirSync(accountRoot, { recursive: true })
    const authPath = join(accountRoot, 'auth')
    symlinkSync(elsewhere, authPath, 'dir')
    try {
      expect(resolveClaudeManagedAuthVerdict(ACCOUNT_ID, authPath).kind).toBe('untrusted')
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it("refuses a symlink even when it resolves to this account's own auth directory", () => {
    // The canonical-path checks alone would accept this: the link resolves to a
    // valid `<root>/<accountId>/auth`. Only the lstat guard rejects a persisted
    // path that is a link rather than the directory itself.
    seedAccount(`${ACCOUNT_ID}\n`)
    const linkPath = join(paths.userDataRoot, 'claude-accounts', ACCOUNT_ID, 'auth-link')
    symlinkSync('auth', linkPath, 'dir')
    expect(resolveClaudeManagedAuthVerdict(ACCOUNT_ID, linkPath).kind).toBe('untrusted')
  })

  it('reports an unreadable marker as indeterminate, not as a stranger directory', () => {
    const authPath = seedAccount(`${ACCOUNT_ID}\n`)
    fsFaults.lockedReadSuffix = MANAGED_AUTH_MARKER
    expect(resolveClaudeManagedAuthVerdict(ACCOUNT_ID, authPath).kind).toBe('indeterminate')
  })

  it('reports an unstattable marker as indeterminate', () => {
    const authPath = seedAccount(`${ACCOUNT_ID}\n`)
    fsFaults.lockedLstatSuffix = MANAGED_AUTH_MARKER
    expect(resolveClaudeManagedAuthVerdict(ACCOUNT_ID, authPath).kind).toBe('indeterminate')
  })

  it('treats a marker naming another account as a trust failure even when adoption is allowed', () => {
    // Adoption writes with `wx`, so the existing marker makes it EEXIST: proof
    // that a marker is there and is not ours, not a write we failed to make.
    const authPath = seedAccount('someone-elses-account\n')
    expect(
      resolveClaudeManagedAuthVerdict(ACCOUNT_ID, authPath, { adoptLegacyMarker: true }).kind
    ).toBe('untrusted')
  })

  it('does not let an unreadable adoption failure escape as a trust verdict', () => {
    // The write can fail for reasons that are not EEXIST, and the thrown value is
    // whatever the failing layer produced — reading `.code` off it must not throw
    // out of the classifier that exists to fail closed.
    const authPath = seedAccount('someone-elses-account\n')
    fsFaults.hostileWriteSuffix = MANAGED_AUTH_MARKER
    const verdict = resolveClaudeManagedAuthVerdict(ACCOUNT_ID, authPath, {
      adoptLegacyMarker: true
    })
    expect(verdict.kind).toBe('indeterminate')
  })

  it('adopts a legacy directory that has no marker at all', () => {
    const authPath = seedAccount(null)
    expect(
      resolveClaudeManagedAuthVerdict(ACCOUNT_ID, authPath, { adoptLegacyMarker: true })
    ).toMatchObject({ kind: 'owned' })
  })

  it('reports a missing directory as a definitive absence', () => {
    const authPath = join(paths.userDataRoot, 'claude-accounts', ACCOUNT_ID, 'auth')
    mkdirSync(join(paths.userDataRoot, 'claude-accounts'), { recursive: true })
    expect(resolveClaudeManagedAuthVerdict(ACCOUNT_ID, authPath)).toEqual({
      kind: 'untrusted',
      reason: MISSING_MANAGED_AUTH_MESSAGE
    })
  })
})

describe('WSL Claude managed-auth verdict', () => {
  beforeEach(() => {
    fsFaults.lockedReadSuffix = null
    fsFaults.lockedLstatSuffix = null
    paths.userDataRoot = mkdtempSync(join(tmpdir(), 'sta5674-verdict-wsl-'))
  })

  afterEach(() => {
    restorePlatform()
    fsFaults.lockedReadSuffix = null
    fsFaults.lockedLstatSuffix = null
    rmSync(paths.userDataRoot, { recursive: true, force: true })
  })

  function seedGuestAuth(accountId: string, marker: { contents?: string; symlink?: boolean }) {
    const guestAuth = join(
      paths.userDataRoot,
      'home/dev/.local/share/orca/claude-accounts',
      accountId,
      'auth'
    )
    mkdirSync(guestAuth, { recursive: true })
    const markerPath = join(guestAuth, MANAGED_AUTH_MARKER)
    if (marker.symlink) {
      writeFileSync(join(guestAuth, 'real-marker'), marker.contents ?? '')
      symlinkSync('real-marker', markerPath)
    } else if (marker.contents !== undefined) {
      writeFileSync(markerPath, marker.contents)
    }
    return guestAuth
  }

  it('host-visible guest path: a marker naming another account is not proof of ownership', async () => {
    setPlatform('linux')
    const guestAuth = seedGuestAuth(ACCOUNT_ID, { contents: 'someone-elses-account\n' })
    const storage = new ClaudeManagedAuthStorage()
    expect((await storage.resolveVerdict(guestAuth, ACCOUNT_ID)).kind).toBe('untrusted')
  })

  it('host-visible guest path: a symlinked marker is not proof of ownership', async () => {
    setPlatform('linux')
    const guestAuth = seedGuestAuth(ACCOUNT_ID, { contents: `${ACCOUNT_ID}\n`, symlink: true })
    const storage = new ClaudeManagedAuthStorage()
    expect((await storage.resolveVerdict(guestAuth, ACCOUNT_ID)).kind).toBe('untrusted')
  })

  it('host-visible guest path: a path whose account segment is another account is refused', async () => {
    setPlatform('linux')
    const guestAuth = seedGuestAuth('another-account', { contents: `${ACCOUNT_ID}\n` })
    const storage = new ClaudeManagedAuthStorage()
    expect((await storage.resolveVerdict(guestAuth, ACCOUNT_ID)).kind).toBe('untrusted')
  })

  it('host-visible guest path: a matching marker is owned', async () => {
    setPlatform('linux')
    const guestAuth = seedGuestAuth(ACCOUNT_ID, { contents: `${ACCOUNT_ID}\n` })
    const storage = new ClaudeManagedAuthStorage()
    expect(await storage.resolveVerdict(guestAuth, ACCOUNT_ID)).toMatchObject({ kind: 'owned' })
  })

  it('host-visible guest path: an unreadable marker is indeterminate', async () => {
    setPlatform('linux')
    const guestAuth = seedGuestAuth(ACCOUNT_ID, { contents: `${ACCOUNT_ID}\n` })
    fsFaults.lockedReadSuffix = MANAGED_AUTH_MARKER
    const storage = new ClaudeManagedAuthStorage()
    expect((await storage.resolveVerdict(guestAuth, ACCOUNT_ID)).kind).toBe('indeterminate')
  })

  it('host-visible guest path: an empty marker is not proof, even with no expected account', async () => {
    setPlatform('linux')
    // `assertOwned(path)` with no account ID still requires the marker to name
    // some account; an empty file is a marker Orca never wrote.
    const guestAuth = seedGuestAuth(ACCOUNT_ID, { contents: '   \n' })
    const storage = new ClaudeManagedAuthStorage()
    expect((await storage.resolveVerdict(guestAuth)).kind).toBe('untrusted')
    const named = seedGuestAuth('other-account', { contents: 'other-account\n' })
    expect(await storage.resolveVerdict(named)).toMatchObject({ kind: 'owned' })
  })

  it('refuses a nested account path that merely shares the suffix, without a probe', async () => {
    setPlatform('win32')
    const storage = new ClaudeManagedAuthStorage()
    // Would throw if it reached `runWslProcess`, which is not mocked here.
    expect(
      await storage.resolveVerdict(
        '\\\\wsl$\\Ubuntu\\home\\dev\\.local\\share\\orca\\claude-accounts\\other\\acct\\auth',
        'acct'
      )
    ).toEqual({ kind: 'untrusted', reason: OUTSIDE_MANAGED_AUTH_ROOT_MESSAGE })
    // The discriminating case: this one really does end in
    // `/claude-accounts/acct/auth`, so only a segment-aware check rejects it.
    expect(
      await storage.resolveVerdict(
        '\\\\wsl$\\Ubuntu\\home\\dev\\.local\\share\\orca\\claude-accounts\\nested\\claude-accounts\\acct\\auth',
        'acct'
      )
    ).toEqual({ kind: 'untrusted', reason: OUTSIDE_MANAGED_AUTH_ROOT_MESSAGE })
    // The one-segment form for the same account is accepted as far as the shape
    // check goes, so the rejection above is the nesting and not the account ID.
    expect(
      await storage.resolveVerdict(
        '\\\\wsl$\\Ubuntu\\home\\dev\\.local\\share\\orca\\claude-accounts\\acct\\auth\\deeper',
        'acct'
      )
    ).toEqual({ kind: 'untrusted', reason: OUTSIDE_MANAGED_AUTH_ROOT_MESSAGE })
  })

  it('refuses a guest path outside the managed accounts root without running a probe', async () => {
    setPlatform('win32')
    const storage = new ClaudeManagedAuthStorage()
    // Would throw if it reached `runWslProcess`, which is not mocked here.
    expect(await storage.resolveVerdict('\\\\wsl$\\Ubuntu\\home\\dev\\.ssh')).toEqual({
      kind: 'untrusted',
      reason: OUTSIDE_MANAGED_AUTH_ROOT_MESSAGE
    })
    expect(
      await storage.resolveVerdict(
        '\\\\wsl$\\Ubuntu\\home\\dev\\.local\\share\\orca\\claude-accounts\\acct\\elsewhere'
      )
    ).toEqual({ kind: 'untrusted', reason: OUTSIDE_MANAGED_AUTH_ROOT_MESSAGE })
  })
})
