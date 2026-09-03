import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A census of which modules may persist Claude credential material, enforced rather than written
 * down.
 *
 * Five consecutive reviews of the hand-maintained version of this list found it incomplete, and the
 * reason was always the same: it was built by searching for *function names*, so it missed any site
 * that spelled the same act differently — a `writeJson` of a snapshot object that happens to carry
 * token bytes, for example. Names are the wrong axis.
 *
 * So this ratchets on the module boundary instead: which files are allowed to reach for a
 * persistence primitive at all. That is exhaustive by construction — it does not depend on
 * predicting how a future write will be spelled. Within an allow-listed module, the call-level
 * classification lives in the plan; the boundary is the part CI enforces.
 */
/**
 * `claude-accounts/` is Claude's by definition. `rate-limits/` is shared with other providers, so
 * only its Claude-named modules are in scope — a Gemini credential writer there is a real writer,
 * but not one this census is about.
 */
const SCANNED_DIRS = ['claude-accounts', 'rate-limits']
const RATE_LIMITS_CLAUDE_ONLY = /(^|\/)claude[-.]/

/** Anything that can create, overwrite, or remove persisted bytes. */
const PERSISTENCE_PRIMITIVES = [
  /\bwriteFileSync\s*\(/,
  /\bwriteFile\s*\(/,
  /\bwriteFileAtomically\s*\(/,
  /\bwriteClaudeManagedAuthFile\s*\(/,
  /\bwriteJson\s*\(/,
  /\brmSync\s*\(/,
  /\bunlinkSync\s*\(/,
  /\brm\s*\(/,
  /ActiveClaudeKeychainCredentials/,
  /ManagedClaudeKeychainCredentials/
]

/**
 * Every module here has been reviewed and classified. Adding a file to this list means asserting
 * that its writes are correct for the lane it serves — isolated macOS accounts read and write the
 * CLI-owned config-dir-scoped Keychain item, and nothing keeps a second copy beside it.
 */
const ALLOWED = new Set([
  'claude-accounts/claude-auth-capture.ts',
  'claude-accounts/claude-login-session.ts',
  'claude-accounts/claude-managed-auth-storage.ts',
  'claude-accounts/claude-stale-fallback-marker.ts',
  'claude-accounts/keychain.ts',
  'claude-accounts/legacy-shared-claude-auth-migration.ts',
  'claude-accounts/managed-auth-path.ts',
  'claude-accounts/per-account-claude-store-migration.ts',
  'claude-accounts/runtime-auth-service.ts',
  'claude-accounts/runtime-auth/runtime-auth-file-storage.ts',
  'claude-accounts/runtime-auth/runtime-auth-keychain-snapshots.ts',
  'claude-accounts/runtime-auth/runtime-auth-managed-credentials.ts',
  'claude-accounts/runtime-auth/runtime-auth-readback.ts',
  'claude-accounts/runtime-auth/runtime-auth-runtime-state.ts',
  'claude-accounts/runtime-auth/runtime-auth-snapshot-capture.ts',
  'claude-accounts/runtime-auth/runtime-auth-snapshot-restore.ts',
  'claude-accounts/runtime-auth/runtime-auth-sync.ts',
  'rate-limits/claude-managed-account-credentials.ts',
  'rate-limits/claude-oauth-credentials.ts'
])

function collectSourceFiles(root: string, dir: string, into: string[]): void {
  for (const entry of readdirSync(join(root, dir))) {
    const rel = `${dir}/${entry}`
    const absolute = join(root, rel)
    if (statSync(absolute).isDirectory()) {
      collectSourceFiles(root, rel, into)
      continue
    }
    if (!entry.endsWith('.ts') || entry.includes('.test.') || entry.includes('harness')) {
      continue
    }
    if (rel.startsWith('rate-limits/') && !RATE_LIMITS_CLAUDE_ONLY.test(rel)) {
      continue
    }
    into.push(rel)
  }
}

describe('Claude credential persistence boundary', () => {
  const mainDir = join(__dirname, '..')

  function modulesThatPersist(): string[] {
    const files: string[] = []
    for (const dir of SCANNED_DIRS) {
      collectSourceFiles(mainDir, dir, files)
    }
    return files
      .filter((rel) => {
        const source = readFileSync(join(mainDir, rel), 'utf-8')
        return PERSISTENCE_PRIMITIVES.some((pattern) => pattern.test(source))
      })
      .map((rel) => rel.split(sep).join('/'))
      .sort()
  }

  it('is confined to the reviewed set of modules', () => {
    // If this fails with an unexpected module, do not just add it: classify what it writes, which
    // lane it serves, and whether it re-creates a second credential copy beside the CLI's store.
    // That second copy is the defect this whole change removes.
    expect(modulesThatPersist()).toEqual([...ALLOWED].sort())
  })

  it('names only modules that still exist', () => {
    for (const rel of ALLOWED) {
      expect(() => statSync(join(mainDir, rel)), `stale allow-list entry: ${rel}`).not.toThrow()
    }
  })

  it('scans the directories that own credential material', () => {
    // Guards the guard: a scan pointed at a directory that does not exist would pass vacuously.
    for (const dir of SCANNED_DIRS) {
      expect(statSync(join(mainDir, dir)).isDirectory()).toBe(true)
    }
    expect(modulesThatPersist().length).toBeGreaterThan(10)
    expect(relative(mainDir, join(mainDir, 'claude-accounts'))).toBe('claude-accounts')
  })
})
