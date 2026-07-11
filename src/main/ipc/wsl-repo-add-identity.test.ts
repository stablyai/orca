/**
 * #6908 regression guard — UI vs CLI WSL repo-add identity parity.
 *
 * The bug: a WSL project added through the UI (WSL picker) failed to discover
 * branches/base refs and could land as a duplicate of the same project added via
 * the `orca` CLI. Two root causes: (i) UI-added WSL repos didn't route git through
 * `wsl.exe`, so discovery ran natively against the `\\wsl.localhost\` UNC and
 * failed; (ii) the CLI's `\\wsl$\` share and the UI's `\\wsl.localhost\` share
 * (plus forward-slash separator variants, #7021) produced different dedup keys.
 *
 * Diagnosis on this branch: Task 7 unified both add paths. Dedup for the UI
 * (`addLocalWslRepo` / `addLocalRepoFromPath`) and the CLI (`runtimePathsEqual`)
 * both key on `normalizeRuntimePathForComparison`, which now folds the legacy
 * `\\wsl$\` prefix and separator style into the modern `\\wsl.localhost\` form;
 * `normalizeGitRepoRootForInputPath` canonicalizes git's Linux `--show-toplevel`
 * back to that same form; and either stored share parses to the same
 * `{distro, linuxPath}` so the runner routes discovery through `wsl.exe -d`.
 *
 * These tests pin that parity — same logical repo, every add path, one identity.
 */

import { describe, expect, it } from 'vitest'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { normalizeWslUncPrefix, parseWslUncPath } from '../../shared/wsl-paths'
import { normalizeGitRepoRootForInputPath } from '../git/repo'
import { toWindowsWslPath } from '../wsl'

const DISTRO = 'Ubuntu'
const LINUX_ROOT = '/home/j/app'
const MODERN_SHARE = String.raw`\\wsl.localhost\Ubuntu\home\j\app`

/** Identity the UI WSL picker persists (mirrors `addLocalWslRepo`). */
function uiWslPickerPath(linuxPath: string, distro: string): string {
  return normalizeWslUncPrefix(toWindowsWslPath(linuxPath, distro))
}

/** Dedup key both add paths compare on (`normalizeRuntimePathForComparison`). */
const dedupKey = normalizeRuntimePathForComparison

/** The `.find` predicate the store dedup uses in every add path. */
function findExisting(repoPaths: string[], candidate: string): string | undefined {
  const key = dedupKey(candidate)
  return repoPaths.find((path) => dedupKey(path) === key)
}

// Every spelling of the SAME WSL repo a user could hand to Orca: the UI picker's
// modern share, the CLI's legacy share, and forward-slash separator variants.
const SAME_REPO_SPELLINGS = [
  MODERN_SHARE,
  String.raw`\\wsl$\Ubuntu\home\j\app`,
  '//wsl.localhost/Ubuntu/home/j/app',
  '//wsl$/Ubuntu/home/j/app'
]

describe('#6908 WSL repo-add identity parity', () => {
  it('collapses every UI/CLI spelling of one repo to a single dedup key', () => {
    // Include a trailing-slash spelling here: the dedup key must tolerate it too.
    const withTrailingSlash = '\\\\wsl.localhost\\Ubuntu\\home\\j\\app\\'
    const keys = new Set([...SAME_REPO_SPELLINGS, withTrailingSlash].map(dedupKey))
    expect(keys.size).toBe(1)
  })

  it('dedups a UI WSL add against a CLI-added repo that differs only by legacy prefix', () => {
    // CLI (`orca repo add`) stores the argument as given; here the legacy share.
    const cliStored = [String.raw`\\wsl$\Ubuntu\home\j\app`]
    const uiCandidate = uiWslPickerPath(LINUX_ROOT, DISTRO)

    expect(uiCandidate).toBe(MODERN_SHARE)
    // One deduped entry: the UI add resolves to the existing CLI repo, no duplicate.
    expect(findExisting(cliStored, uiCandidate)).toBe(cliStored[0])
  })

  it('resolves the same git root regardless of the input share prefix or separators', () => {
    // getGitRepoRoot routes through WSL and gets a Linux `--show-toplevel`; its
    // canonicalization must land on the modern share for any WSL-UNC input.
    for (const input of SAME_REPO_SPELLINGS) {
      expect(normalizeGitRepoRootForInputPath(input, LINUX_ROOT)).toBe(MODERN_SHARE)
    }
  })

  it('routes branch discovery through wsl.exe for either stored share', () => {
    // The runner keys WSL routing on parseWslUncPath(cwd); both the UI and CLI
    // stored forms must yield the same distro + Linux path so `git` for base-ref
    // discovery runs inside the distro instead of failing natively.
    for (const stored of SAME_REPO_SPELLINGS) {
      expect(parseWslUncPath(stored)).toEqual({ distro: DISTRO, linuxPath: LINUX_ROOT })
    }
  })

  it('documents the pre-fix drift: raw share strings differ without normalization', () => {
    // Why keep this: the whole bug was comparing these raw strings. It guards the
    // reason `normalizeRuntimePathForComparison` must fold the prefix, not the fold.
    const legacy = String.raw`\\wsl$\Ubuntu\home\j\app`
    expect(legacy).not.toBe(MODERN_SHARE)
    expect(dedupKey(legacy)).toBe(dedupKey(MODERN_SHARE))
  })
})
