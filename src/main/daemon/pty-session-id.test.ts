import { describe, expect, it } from 'vitest'
import { isSafePtySessionId, mintPtySessionId } from './pty-session-id'

const USER_DATA = '/tmp/orca-userdata'

describe('mintPtySessionId', () => {
  it('returns a UUID when no worktreeId is provided', () => {
    const id = mintPtySessionId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('prefixes the worktreeId and suffixes an 8-char hex tag', () => {
    const id = mintPtySessionId('wt-alpha')
    expect(id).toMatch(/^wt-alpha@@[0-9a-f]{8}$/)
  })

  it('preserves path-shaped worktreeIds verbatim in the prefix', () => {
    // Why: real worktreeIds are `${repo.id}::${absolutePath}` and contain
    // slashes. The mint must not rewrite or sanitize them — reconcileOnStartup
    // splits on `@@` to recover the worktreeId.
    const id = mintPtySessionId('repo-123::/Users/me/work/wt-1')
    expect(id).toMatch(/^repo-123::\/Users\/me\/work\/wt-1@@[0-9a-f]{8}$/)
  })
})

describe('isSafePtySessionId', () => {
  it('accepts minted UUIDs', () => {
    expect(isSafePtySessionId(mintPtySessionId(), USER_DATA)).toBe(true)
  })

  it('accepts minted worktree-scoped ids (happy path, hyphen-only)', () => {
    expect(isSafePtySessionId(mintPtySessionId('wt-alpha'), USER_DATA)).toBe(true)
  })

  it('accepts minted ids with path-shaped worktreeIds containing slashes', () => {
    // Why: real worktreeIds are `${repo.id}::${absolutePath}`, so the minted
    // sessionId contains `/` in its prefix. A char-denylist validator that
    // rejected `/` would break every real daemon spawn.
    const id = mintPtySessionId('repo-abc123::/Users/thebr/work/wt-1')
    expect(isSafePtySessionId(id, USER_DATA)).toBe(true)
  })

  it('accepts caller-supplied path-shaped ids that stay inside userData', () => {
    expect(isSafePtySessionId('some-repo::/Users/me/wt/abc@@deadbeef', USER_DATA)).toBe(true)
  })

  it('rejects empty string', () => {
    expect(isSafePtySessionId('', USER_DATA)).toBe(false)
  })

  it('rejects ids longer than 512 characters', () => {
    expect(isSafePtySessionId('a'.repeat(513), USER_DATA)).toBe(false)
  })

  it('rejects ids containing a NUL byte', () => {
    expect(isSafePtySessionId('safe\0evil', USER_DATA)).toBe(false)
  })

  it('rejects ids that traverse out of userData via ..', () => {
    expect(isSafePtySessionId('../etc/passwd', USER_DATA)).toBe(false)
  })

  it('rejects ids that traverse out of userData via deep ..', () => {
    expect(isSafePtySessionId('sub/../../etc/passwd', USER_DATA)).toBe(false)
  })

  it('rejects ids that resolve to the userData root itself', () => {
    // Why: if id resolves to `.` (the root), callers could overwrite userData
    // meta files. Guard ensures the target is a strict subpath.
    expect(isSafePtySessionId('.', USER_DATA)).toBe(false)
  })

  it('accepts ids with nested valid path segments inside userData', () => {
    // Why: minted ids can contain `/` (from worktreeId::absolute-path) so the
    // validator must allow that as long as the result stays inside userData.
    expect(isSafePtySessionId('sub/path/ok@@12345678', USER_DATA)).toBe(true)
  })
})
