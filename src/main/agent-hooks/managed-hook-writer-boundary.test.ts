import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Keep every writer of user-global agent config behind one authorization verdict.
 *
 * `installManagedAgentHooks` is the chokepoint and resolves the verdict itself, so its callers need
 * nothing. The writers below bypass it — they write a remote host's configs, a WSL guest's, or the
 * user's real `~/.codex` — so each must obtain the verdict for itself. Four independent passes over
 * this codebase counted the writers as 5, then 7, then 14, then ~20; this test is what stops the
 * next one from being missed.
 *
 * WHAT THIS CANNOT CATCH, and is not evidence about:
 * - a file that names the policy but never lets it decide. This scans for the reference, not for
 *   the call being on the write path, so it proves a writer was CONNECTED to the policy once, not
 *   that it still obeys it. Measured: replacing a real call with a hardcoded `allow` while leaving
 *   the import in place keeps this green. Only the behavioural tests next to each writer catch it;
 * - a dynamic `require()` or a string-built import of any of these modules;
 * - a writer reached through an injected callback (`deps.installHooks`), which is exactly how
 *   `wsl-hook-fs-adapter.ts` works — its gate lives in the caller, not in it;
 * - a shell command generated as text and run on a remote host or inside a distro;
 * - the `orca` CLI's own process, or the relay bundle, which are separate programs;
 * - a future writer that edits a config file through a lower-level helper this list does not name.
 * Those remain review and integration-test responsibilities.
 */

/** Writers that do NOT pass through `installManagedAgentHooks`. */
const BYPASSING_WRITER_SYMBOLS = [
  'ensureRealHomeCodexHookState',
  'installRemoteManagedAgentHooks',
  'installWslGuestHooks'
] as const

/** The modules that DEFINE the writers above. A definition is not a call site. */
const WRITER_OWNER_MODULES = [
  'src/main/codex/codex-real-home-hook-install.ts',
  'src/main/agent-hooks/remote-managed-hook-installers.ts'
] as const

/**
 * Accepted evidence that a file obtained the verdict: the policy module itself, or one of the two
 * named adapters that do nothing but return it.
 */
const POLICY_EVIDENCE = [
  'managed-hook-install-policy',
  'resolveStartupManagedHookPlan',
  'isWslGuestManagedHookInstallAllowed'
] as const

/**
 * Files that import a bypassing writer and legitimately hold no verdict. Each line is a reason, not
 * a parking space; the list may only shrink.
 */
const WRITER_BOUNDARY_ALLOWLIST: Record<string, string> = {
  // Runs inside the relay on the remote host or WSL guest. The host decides whether to send the
  // install RPC at all; this process has no settings store to consult.
  'src/main/agent-hooks/managed-hook-runtime.ts': 'relay-side receiver, gated by the sender',
  // Takes the installer as an injected `typeof` parameter. Its only caller,
  // wsl-hook-relay-guest-install.ts, holds the gate.
  'src/main/agent-hooks/wsl-hook-fs-adapter.ts': 'injected installer, gated by its caller',
  // Declares the installer as the production default of a DI seam and gates relay start on the
  // verdict through isWslHookRelayAllowed.
  'src/main/agent-hooks/wsl-hook-relay-deps.ts': 'owns the gate itself'
}

const SCANNED_EXTENSIONS = ['.ts', '.tsx']
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  '.git',
  '__fixtures__'
])

function isTestFile(path: string): boolean {
  return /\.(?:test|spec)\.tsx?$/.test(path) || path.includes('/__tests__/')
}

function collectSourceFiles(root: string): string[] {
  let found: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return found
  }
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry)) {
      continue
    }
    const full = join(root, entry)
    if (statSync(full).isDirectory()) {
      found = found.concat(collectSourceFiles(full))
      continue
    }
    if (SCANNED_EXTENSIONS.some((extension) => full.endsWith(extension))) {
      found.push(full)
    }
  }
  return found
}

/** Drop comment-only lines so prose naming a writer is not an offender. */
function codeText(contents: string): string {
  return contents
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
}

const repoRoot = resolve(__dirname, '..', '..', '..')
const files = collectSourceFiles(join(repoRoot, 'src'))
  .map((file) => relative(repoRoot, file).split('\\').join('/'))
  .filter((path) => !isTestFile(path))

const writers = files
  .map((path) => ({ path, code: codeText(readFileSync(join(repoRoot, path), 'utf8')) }))
  .filter(({ code }) => BYPASSING_WRITER_SYMBOLS.some((symbol) => code.includes(symbol)))
  .filter(({ path }) => !WRITER_OWNER_MODULES.some((owner) => path === owner))

describe('managed hook writer boundary', () => {
  it('scans a plausible number of files', () => {
    // A broken root or extension list would make the guard silently vacuous.
    expect(files.length).toBeGreaterThan(500)
  })

  it('finds the writers it is meant to be guarding', () => {
    // Renaming every symbol out from under this list would otherwise leave it green and empty.
    expect(writers.length).toBeGreaterThanOrEqual(6)
  })

  it('gives every bypassing writer its own policy verdict', () => {
    const unguarded = writers
      .filter(({ path }) => !(path in WRITER_BOUNDARY_ALLOWLIST))
      .filter(({ code }) => !POLICY_EVIDENCE.some((evidence) => code.includes(evidence)))
      .map(({ path }) => path)

    expect(
      unguarded,
      'This file writes user-global agent config without asking the install policy. Call ' +
        'resolveManagedHookInstallDecision from src/main/agent-hooks/managed-hook-install-policy.'
    ).toEqual([])
  })

  it('has no stale allowlist entry', () => {
    const scanned = new Set(writers.map(({ path }) => path))
    const stale = Object.keys(WRITER_BOUNDARY_ALLOWLIST).filter((path) => !scanned.has(path))

    expect(stale, 'Allowlist entry no longer touches a writer — delete the line.').toEqual([])
  })
})
