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
  for (const match of source.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*[^,;\n]*['"`]wsl\.exe['"`]/g)) {
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
  if (/\breturn\s+['"`]wsl\.exe['"`]/.test(source) && /\b\w*(?:spawn|exec)\w*\s*\(/i.test(source)) {
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

function passesComparedWslShellPathToSpawnSpec(source: string): boolean {
  for (const match of source.matchAll(
    /\bbasename\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\)\.toLowerCase\(\)\s*===\s*['"`]wsl\.exe['"`]/g
  )) {
    const shellPath = match[1]!.replace(/[.$]/g, '\\$&')
    const spawnCall = new RegExp(
      `\\b\\w*(?:spawn|exec|run)\\w*\\s*\\(\\s*(?:${shellPath}\\b|\\{[\\s\\S]{0,2000}?\\bshellPath\\s*:\\s*${shellPath}\\b)`,
      'i'
    )
    if (spawnCall.test(source)) {
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
    if (
      bindsWslBinaryToASpawnedIdentifier(source) ||
      passesComparedWslShellPathToSpawnSpec(source)
    ) {
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
type CallRange = { text: string; start: number; end: number }

function collectRunnerCallArguments(source: string): CallRange[] {
  const blanked = blankStringContents(source)
  const calls: CallRange[] = []
  const callees = new Set(['runWslProcess'])
  for (const alias of source.matchAll(/\brunWslProcess\s+as\s+(\w+)/g)) {
    callees.add(alias[1]!)
  }
  const callPattern = new RegExp(`\\b(?:${[...callees].join('|')})\\s*\\(`, 'g')
  for (const match of blanked.matchAll(callPattern)) {
    // The WHOLE argument list, not the first `{...}`: with
    // `Object.assign({ loginPath }, { script })` the payload sits in the second
    // literal, and stopping at the first one collected an object with no
    // script and no bashism -- which reads exactly like a clean call.
    const open = match.index + match[0].length - 1
    let depth = 0
    for (let index = open; index < blanked.length; index += 1) {
      const char = blanked[index]
      if (char === '(') {
        depth += 1
      } else if (char === ')') {
        depth -= 1
        if (depth === 0) {
          calls.push({ text: source.slice(open, index + 1), start: open, end: index + 1 })
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
    const calls = collectRunnerCallArguments(source)
    // Per-call: an unpinned payload sitting beside a pinned one.
    if (calls.some(({ text }) => BASHISM.test(text) && !text.includes("shell: 'bash'"))) {
      offenders.push(relativePath)
      continue
    }
    // Anything that is not a plain object literal is judged unreadable, and an
    // unreadable call must pin bash.
    //
    // Six review rounds of widening this regex produced more evasions -- a
    // ternary with one pinned branch, an `as` assertion carrying the pin,
    // `Object.assign` -- because a regex cannot tell which object a key
    // belongs to. So stop guessing: a ternary, a spread or an assertion makes
    // the call opaque, and opacity requires the pin rather than excusing it.
    //
    // A nested CALL is deliberately not exotic: `script: \`x ${shellQuote(p)}\``
    // is the ordinary way every payload here is built, and flagging it would
    // demand `shell: 'bash'` on POSIX payloads that must not have it.
    // A ternary only makes the call opaque when it CHOOSES the spec, i.e. it
    // sits before the first `{`. One inside the object picks a script line and
    // is both common and harmless (claude-accounts/service.ts:977).
    const isExotic = (text: string): boolean => {
      const body = text.replace(/^\(/, '')
      const firstBrace = body.indexOf('{')
      const prefix = firstBrace === -1 ? body : body.slice(0, firstBrace)
      return /\?[^.:]|\.\.\./.test(prefix) || /\bas\s+[A-Za-z{]/.test(body)
    }
    // No `includes("shell: 'bash'")` escape here: in `cond ? {pinned} : {not}`
    // the pin belongs to one branch and the substring test cannot tell which,
    // so a pinned branch excused an unpinned one. An exotic call therefore
    // cannot be excused -- write it as a plain object literal instead.
    if (calls.some(({ text }) => isExotic(text)) && BASHISM.test(source)) {
      offenders.push(relativePath)
      continue
    }
    // An opaque payload is judged by the whole file, minus anything already
    // declared bash.
    //
    // Requiring merely that `shell:` be PRESENT was strictly weaker than the
    // file-wide rule it replaced: `shell: 'sh'` on a bash payload shipped
    // green, which is #14292 with extra steps. Resolving the identifier is
    // guesswork, so instead: strip the text of every call that already names
    // bash, and if a bashism survives anywhere in the file while a
    // script-carrying call is not bash-pinned, flag it.
    //
    // Stripping the bash-pinned calls is what keeps codex-accounts/service.ts
    // clean -- it pins bash on four inline payloads and on a `bash -lc`
    // execFileSync, and correctly leaves its printf/mkdir calls unpinned.
    // Masked by POSITION, not by String.replace: replace() with a string
    // pattern removes only the first match, so two identically-written pinned
    // calls would leave one behind, and a body that also occurs earlier as a
    // substring would blank the wrong region.
    const pinnedRanges: [number, number][] = [
      ...calls
        .filter(({ text }) => text.includes("shell: 'bash'"))
        .map(({ start, end }): [number, number] => [start, end]),
      ...[...source.matchAll(/'bash',\s*\n?\s*'-lc',[\s\S]{0,4000}?\n\s*\]/g)].map(
        (m): [number, number] => [m.index, m.index + m[0].length]
      )
    ]
    const masked = source.split('')
    for (const [from, to] of pinnedRanges) {
      for (let index = from; index < to; index += 1) {
        masked[index] = ' '
      }
    }
    const unpinnedRegion = masked.join('')
    // A spread hides every key, `script` and `shell` alike, so it has to count
    // as carrying a script -- otherwise `runWslProcess({ ...spec })` is a hole
    // the file-wide arm never looks at.
    const scriptCalls = calls.filter(({ text }) => /\bscript\b/.test(text) || /\.\.\./.test(text))
    // Zero collected calls is not zero risk: `Object.assign({...}, {script})`
    // puts the payload in the second literal, and a renamed callee that the
    // alias scan misses collects nothing at all. If the file carries a bashism
    // and the guard cannot see any call object, that is unreadable, not clean.
    const unreadable = calls.length === 0
    if (
      BASHISM.test(unpinnedRegion) &&
      (unreadable || scriptCalls.some(({ text }) => !text.includes("shell: 'bash'")))
    ) {
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
    expect(offenders).toContain('main/git/command-runner/wsl-command-resolution.ts')
    expect(offenders).toContain('main/providers/local-pty-spawn.ts')
  })

  it('adds no new direct wsl.exe spawn', () => {
    expect(offenders.filter((path) => !ALLOWLIST.includes(path))).toEqual([])
  })

  it('carries no stale allowlist entry', () => {
    // A migrated file must leave the list, or the goalpost stops moving.
    expect(ALLOWLIST.filter((path) => !offenders.includes(path))).toEqual([])
  })
})
