import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guard the one WSL failure mode that keeps coming back in different clothes:
 * a probe that reports "not there" when it actually means "could not ask".
 *
 * `catch { return false }` is not itself the bug -- an uncached caller just
 * asks again and the answer corrects itself. The bug is what happens when that
 * value is cached or used to gate discovery: a distro that was busy for one
 * second reports no git, or no agent sessions, for the rest of the session.
 * It has shipped that way at least three times (see the allowlist header).
 *
 * A repo-wide rule is not workable -- the shape appears ~850 times in `src/`
 * and is usually correct, because for most callers a failure genuinely does
 * mean absent. It is only dangerous where the answer describes a WSL distro,
 * which is why the scan is scoped to the probe modules that own those answers.
 *
 * This guard cannot see the dangerous part. Whether a swallowed value gets
 * pinned is dataflow, not syntax. What it can do is stop a new swallow site
 * from appearing in these modules without someone saying out loud why it is
 * safe to pin -- which is the review that was missing all three times.
 */
const SWALLOW_ALLOWLIST: readonly string[] = readFileSync(
  join(__dirname, '__fixtures__', 'wsl-probe-failure-swallow-allowlist.txt'),
  'utf8'
)
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'))

/**
 * The probe modules that answer questions *about a WSL distro*. Scoped
 * deliberately: outside these, a swallowed failure is somebody else's
 * judgement call and usually a correct one.
 */
const SCANNED_ROOTS = ['main/wsl', 'main/preflight', 'main/ipc/preflight']

/** `catch { return <indistinguishable-from-a-real-negative> }`.
 *
 *  Comments are tolerated on BOTH sides of the return: the doc asks authors to
 *  write down why a swallow is safe, and the natural place for that sentence is
 *  trailing the `return` — which must not be a way to slip past the guard. */
const SWALLOW_PATTERN =
  /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*return\s+(?:false|\[\]|null|undefined|new Set\(\)|new Map\(\))\s*;?\s*(?:\/\/[^\n]*\n?\s*|\/\*[\s\S]*?\*\/\s*)*\}/

const SRC_ROOT = resolve(__dirname, '..', '..')

/** Prefix match on purpose: the probes live both in a directory (`main/wsl/`)
 *  and as siblings named for it (`main/wsl.ts`, `main/ipc/preflight-*.ts`). */
function isScanned(relativePath: string): boolean {
  return SCANNED_ROOTS.some((root) => relativePath.startsWith(root))
}

/** Tests may swallow freely -- they are not shipped and several exist to drive
 *  the failure path on purpose. */
function isTestFile(path: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(path)
}

function collectTypeScriptFiles(directory: string, found: string[]): void {
  for (const entry of readdirSync(directory)) {
    if (entry === '__fixtures__' || entry === 'node_modules') {
      continue
    }
    const absolute = join(directory, entry)
    if (statSync(absolute).isDirectory()) {
      collectTypeScriptFiles(absolute, found)
      continue
    }
    if (absolute.endsWith('.ts') && !isTestFile(absolute)) {
      found.push(absolute)
    }
  }
}

function findSwallowingFiles(): string[] {
  const candidates: string[] = []
  collectTypeScriptFiles(SRC_ROOT, candidates)
  return candidates
    .map((absolute) => relative(SRC_ROOT, absolute).split('\\').join('/'))
    .filter(isScanned)
    .filter((relativePath) =>
      SWALLOW_PATTERN.test(readFileSync(join(SRC_ROOT, relativePath), 'utf8'))
    )
    .sort()
}

const ALLOWLIST_PATH = 'src/main/wsl/__fixtures__/wsl-probe-failure-swallow-allowlist.txt'
const GUIDANCE = `See docs/reference/wsl-probe-failure-semantics.md`

describe('WSL probe failure semantics', () => {
  it('records every probe module that reports a failure as a negative answer', () => {
    const allowed = new Set(SWALLOW_ALLOWLIST)
    const unlisted = findSwallowingFiles().filter((file) => !allowed.has(file))
    expect(
      unlisted,
      unlisted.length === 0
        ? ''
        : `New WSL probe module(s) turn a failure into a negative answer:\n` +
            `${unlisted.map((file) => `  - ${file}`).join('\n')}\n\n` +
            `That is only safe while nothing caches the value or uses it to gate\n` +
            `discovery. If it is safe, add the file to ${ALLOWLIST_PATH}\n` +
            `with a note saying why. If it is not, ${GUIDANCE} for the options.`
    ).toEqual([])
  })

  it('keeps the allowlist honest', () => {
    const swallowing = new Set(findSwallowingFiles())
    const stale = SWALLOW_ALLOWLIST.filter((entry) => !swallowing.has(entry))
    // Why fail on a stale entry rather than ignore it: an entry that no longer
    // matches means the file was fixed, and leaving it listed would let the
    // next swallow site slip back in under an allowance nobody re-reviewed.
    expect(
      stale,
      stale.length === 0
        ? ''
        : `These entries no longer match — the files were fixed. Nothing is\n` +
            `wrong with your change; the ratchet just needs to shrink.\n` +
            `Delete from ${ALLOWLIST_PATH}:\n` +
            `${stale.map((entry) => `  - ${entry}`).join('\n')}`
    ).toEqual([])
  })
})
