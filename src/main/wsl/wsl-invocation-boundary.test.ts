import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  blankStringContents,
  blankStringContentsDesynced,
  stripComments
} from '../../shared/source-scan/source-tree-scan'

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
 * (`const f = cond ? 'wsl.exe' : x`) is caught separately, by
 * `bindsWslBinaryToASpawnedIdentifier`.
 */
const SPAWN_OPENER = /\b[A-Za-z_$][\w$]*\s*\(\s*$|(?:program|binary|command|file|shellPath):\s*$/

/*
 * The five files this comment used to list as an unscannable blind spot are
 * now handled: three bind `wsl.exe` to a variable and spawn it, and are real
 * allowlist entries; the other two never spawned it at all -- one compares a
 * basename, one lists it among accepted shells. Recording a gap in prose was
 * worse than it looked, because the count is the goalpost and it was wrong by
 * three in the direction that hides offenders.
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

/**
 * `const binary = 'wsl.exe'` ... `spawn(binary)`, which no test over the
 * literal's neighbourhood can see.
 *
 * Why it earns its place: the neighbourhood test was the whole guard, and a
 * planted `const p = 'wsl.exe'; spawnProcess(p)` passed it. Five files were
 * already known to spawn this way and were recorded in a comment instead of
 * the allowlist, which means the count -- the actual goalpost -- was wrong by
 * five and any NEW indirect spawner would have been invisible.
 */
function bindsWslBinaryToASpawnedIdentifier(source: string): boolean {
  const bound = new Set<string>()
  // Covers `const x = 'wsl.exe'`, a ternary picking it, and `binary: 'wsl.exe'`.
  // `const x =`, and the class-field spellings (`private readonly x =`). `[^=]`
  // rather than `[^=;\n]` so a Prettier-wrapped ternary still binds.
  for (const match of source.matchAll(
    /(?:(?:const|let|var|readonly|private|public|protected|static)\s+)+([A-Za-z_$][\w$]*)[^=\n]*=[^;]{0,200}?['"`]wsl\.exe['"`]/g
  )) {
    bound.add(match[1]!)
  }
  for (const match of source.matchAll(
    /\b([A-Za-z_$][\w$]*)\s*:\s*[^,;\n]*['"`]wsl\.exe['"`]/g
  )) {
    bound.add(match[1]!)
  }
  // Assignment with no declarator: `this.binary = 'wsl.exe'`, and the split
  // form `let shellPath: string` ... `shellPath = 'wsl.exe'`, which a
  // declarator-anchored pattern cannot see. `[^;]{0,200}?` so a wrapped
  // right-hand side still binds.
  for (const match of source.matchAll(
    /(?:\bthis\.)?([A-Za-z_$][\w$]*)\s*=[^=][^;]{0,200}?['"`]wsl\.exe['"`]/g
  )) {
    bound.add(match[1]!)
  }
  // A helper that hands back the binary is a spawn site one hop away, and the
  // hop is untrackable by regex -- but only when this file also spawns
  // something. Returning the name as terminal metadata is not a spawn.
  if (
    /\breturn\s+['"`]wsl\.exe['"`]/.test(source) &&
    /\b\w*(?:spawn|exec)\w*\s*\(/i.test(source)
  ) {
    return true
  }
  for (const name of bound) {
    const identifier = name.replace(/[$]/g, '\\$&')
    // The identifier reaching a call opener, a spawn-style field, or the first
    // argument of a spawn-style call.
    if (
      new RegExp(`\\b${identifier}\\s*\\(`).test(source) ||
      new RegExp(
        `(?:program|binary|command|file|shellPath)\\s*:\\s*(?:this\\.)?${identifier}\\b`
      ).test(source) ||
      // `this.` so a class field reaching `spawnProcess(this.binary)` counts.
      new RegExp(`\\b\\w*(?:spawn|exec|run)\\w*\\s*\\(\\s*(?:this\\.)?${identifier}\\b`, 'i').test(
        source
      )
    ) {
      return true
    }
  }
  return false
}

function findSpawnSites(): string[] {
  const offenders = new Set<string>()
  for (const path of collectSourceFiles(SOURCE_ROOT)) {
    const relativePath = relative(SOURCE_ROOT, path).replace(/\\/g, '/')
    if (isTestFile(relativePath) || relativePath.startsWith(OWNER_DIRECTORY)) {
      continue
    }
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(/['"`]wsl\.exe['"`]/g)) {
      // Collapse the preceding whitespace so a call broken across lines by the
      // formatter still reads as one opener.
      const preceding = source.slice(Math.max(0, match.index - 60), match.index)
      if (SPAWN_OPENER.test(preceding.replace(/\s+/g, ' ').replace(/ $/, ''))) {
        offenders.add(relativePath)
      }
    }
    if (bindsWslBinaryToASpawnedIdentifier(source)) {
      offenders.add(relativePath)
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

/**
 * The argument object of every `runWslProcess(` call in a file.
 *
 * Why per-call and not per-file: a file-wide `shell: 'bash'` check passes as
 * soon as ANY call in the file pins bash, so an unpinned dash payload added
 * beside a pinned one is invisible -- planted in `codex-accounts/service.ts`
 * and the guard stayed green. That is the #14292 signature shipping again.
 *
 * Braces are matched on string-blanked source so a `}` inside a script literal
 * cannot close the object early; offsets survive blanking, so the slice is
 * taken from the real source and the payload is still readable.
 */
function collectRunnerCallArguments(source: string): string[] {
  const blanked = blankStringContents(source)
  const calls: string[] = []
  for (const match of blanked.matchAll(/\brunWslProcess\s*\(/g)) {
    const open = blanked.indexOf('{', match.index)
    if (open === -1) {
      continue
    }
    let depth = 0
    for (let index = open; index < blanked.length; index += 1) {
      const char = blanked[index]
      if (char === '{') {
        depth += 1
      } else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          calls.push(source.slice(open, index + 1))
          break
        }
      }
    }
  }
  return calls
}

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
    if (!source.includes('runWslProcess')) {
      continue
    }
    // Fail closed. A desynced lexer finds zero calls, and "zero calls" is
    // indistinguishable from "zero violations" -- this guard passed a planted
    // dash payload for exactly that reason, because one regex literal earlier
    // in the file had inverted the scan.
    if (blankStringContentsDesynced(source)) {
      offenders.push(relativePath)
      continue
    }
    for (const call of collectRunnerCallArguments(source)) {
      if (BASHISM.test(call) && !call.includes("shell: 'bash'")) {
        offenders.push(relativePath)
        break
      }
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
