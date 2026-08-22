import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stripComments } from '../../shared/source-scan/source-tree-scan'

/**
 * Every `wsl.exe` spawn must go through `runWslProcess`.
 *
 * Why a guard and not review: five decisions have to be made on each call
 * (separator, shell, stdout fencing, WSLENV, payload transport), each is
 * invisible in a diff, and each has shipped wrong. `wsl-exec-mode-separator`
 * already guards one of the five — this guards the call itself, so the other
 * four cannot be re-decided per site.
 *
 * The allowlist is the W3 migration worklist and only shrinks. Its length is
 * the workstream's measured goalpost.
 */
const ALLOWLIST: readonly string[] = readFileSync(
  join(__dirname, '__fixtures__', 'wsl-invocation-allowlist.txt'),
  'utf8'
)
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'))

const SOURCE_ROOT = resolve(__dirname, '../..')
// Why the trailing slash: a bare 'main/wsl' prefix also exempts main/wsl.ts,
// main/wsl-availability.ts and main/wsl-unc-delete.ts -- three files that spawn
// wsl.exe directly. Caught by testing the guard against a planted call site.
const OWNER_DIRECTORY = 'main/wsl/'
const IGNORED = new Set(['node_modules', 'dist', 'out', 'build', '.git', '__fixtures__'])
/**
 * A spawn site: the `wsl.exe` literal reaches a child process.
 *
 * Why this is broader than "sits inside `spawn(`": the first draft only matched
 * a named opener, and it missed the single largest wsl.exe spawner in the tree
 * -- `git/runner.ts`, which assigns `binary: 'wsl.exe'` and spawns it four
 * lines later. It also missed locally-aliased callers (`run(`, `execFileUtf8(`)
 * and `command:` fields. A guard whose count is wrong is worse than no guard,
 * because the count is the goalpost.
 *
 * Any identifier followed by `(` counts as an opener, and the assignment-style
 * fields are matched by name. Indirection through a variable
 * (`const f = cond ? 'wsl.exe' : x`) is still invisible; those files are listed
 * explicitly below so the gap is recorded rather than implied.
 */
const SPAWN_OPENER = /\b[A-Za-z_$][\w$]*\s*\(\s*$|(?:program|binary|command|file|shellPath):\s*$/

/*
 * Known blind spot, recorded rather than implied: these files assign
 * `'wsl.exe'` to a variable and spawn it elsewhere, which no regex over the
 * literal's neighbourhood can see. They are NOT in the allowlist, because the
 * stale-entry check would reject an entry the scanner cannot find -- so the
 * guard's count under-reports by these five, and this comment is the record.
 *
 *   main/rate-limits/claude-pty.ts
 *   main/providers/local-pty-provider.ts
 *   main/daemon/pty-subprocess.ts
 *   relay/pty-shell-launch.ts
 *   relay/pty-handler.ts
 *
 * All five are PTY-pane launches, which are out of W3's scope anyway: they go
 * through node-pty, not a child-process wrapper.
 */

function isTestFile(path: string): boolean {
  return (
    /\.(?:test|spec)\.tsx?$/.test(path) ||
    /(?:test-harness|test-utils|test-setup|test-fixture|repro)/.test(path)
  )
}

function collectSourceFiles(root: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(root)) {
    if (IGNORED.has(entry) || entry.startsWith('.')) {
      continue
    }
    const path = join(root, entry)
    if (statSync(path).isDirectory()) {
      found.push(...collectSourceFiles(path))
      continue
    }
    if (/\.tsx?$/.test(entry)) {
      found.push(path)
    }
  }
  return found
}

function findSpawnSites(): string[] {
  const offenders = new Set<string>()
  for (const path of collectSourceFiles(SOURCE_ROOT)) {
    const relativePath = relative(SOURCE_ROOT, path).replace(/\\/g, '/')
    if (isTestFile(relativePath) || relativePath.startsWith(OWNER_DIRECTORY)) {
      continue
    }
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(/['"]wsl\.exe['"]/g)) {
      // Collapse the preceding whitespace so a call broken across lines by the
      // formatter still reads as one opener.
      const preceding = source.slice(Math.max(0, match.index - 60), match.index)
      if (SPAWN_OPENER.test(preceding.replace(/\s+/g, ' ').replace(/ $/, ''))) {
        offenders.add(relativePath)
      }
    }
  }
  return [...offenders].sort()
}

/**
 * A bash-only payload must say `shell: 'bash'`.
 *
 * Why: the runner's `script` runs under `sh`, which on Debian/Ubuntu is dash.
 * A payload using process substitution, `local` or `[[ ]]` fails there with
 * `Syntax error: word unexpected` -- the #14292 signature. A migration that
 * swaps `bash -c` for the runner without saying so introduces exactly that,
 * and no unit test catches it because the tests mock the runner.
 */
/**
 * Bash-only constructs. `pipefail` and `read -d` are the easy ones to miss:
 * they look like ordinary shell, and dash accepts neither.
 */
const BASHISM =
  /<\s*<\(|\[\[|\blocal\s+\w+=|\bdeclare\s+-|\bmapfile\b|set\s+-[a-z]*o[a-z]*\s+pipefail|set\s+-euo\b|read\s+(?:-\w+\s+)*-d\b|<<</

describe('bash-only payloads declare their interpreter', () => {
  const offenders: string[] = []
  for (const path of collectSourceFiles(SOURCE_ROOT)) {
    const relativePath = relative(SOURCE_ROOT, path).replace(/\\/g, '/')
    // The runner's own file documents these constructs; it does not run them.
    if (isTestFile(relativePath) || relativePath.startsWith(OWNER_DIRECTORY)) {
      continue
    }
    // Strip comments: a comment naming runWslProcess and quoting `set -euo
    // pipefail` to explain why it was removed would otherwise flag the file,
    // and a bash script written to a guest file is not a runner payload.
    const source = stripComments(readFileSync(path, 'utf8'))
    if (!source.includes('runWslProcess') || !BASHISM.test(source)) {
      continue
    }
    if (!source.includes("shell: 'bash'")) {
      offenders.push(relativePath)
    }
  }

  it('every runner caller with a bash-only script pins bash', () => {
    expect(offenders).toEqual([])
  })
})

describe('wsl.exe is spawned through one runner', () => {
  const offenders = findSpawnSites()


  it('still detects a known spawn shape', () => {
    // Why name a specific file rather than assert a total: `offenders.length +
    // ALLOWLIST.length >= N` cannot fail while the allowlist alone exceeds N,
    // so it passed even for a scanner that found nothing. This fails the moment
    // detection stops seeing a call that is definitely there.
    expect(offenders).toContain('main/git/runner.ts')
  })

  it('adds no new direct wsl.exe spawn', () => {
    expect(offenders.filter((path) => !ALLOWLIST.includes(path))).toEqual([])
  })

  it('carries no stale allowlist entry', () => {
    // A migrated file must leave the list, or the goalpost stops moving.
    expect(ALLOWLIST.filter((path) => !offenders.includes(path))).toEqual([])
  })
})
