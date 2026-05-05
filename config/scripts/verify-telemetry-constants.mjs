#!/usr/bin/env node

// Asserts that the telemetry compile-time constants — `ORCA_BUILD_IDENTITY`
// and `ORCA_POSTHOG_WRITE_KEY` — were substituted into the shipped binary.
// Closes the gap PR #1385 flagged: a release built without those env vars
// produces an `IS_OFFICIAL_BUILD === false` binary that ships silently and
// transmits nothing. This script runs after `electron-builder` has packed
// the app and BEFORE the GitHub release is flipped from draft → published.
// A failure here fails the matrix job; the draft release stays in place
// until a human resolves it.
//
// We grep the packed `app.asar`'s `out/main/index.js` (the same file that
// the runtime loads) rather than the unpacked `out/`. asar is a tar-like
// archive that doesn't transform contents, so the two are byte-equivalent
// today — but verifying the asar protects against any future config change
// that excludes `out/main/index.js` from the package.
//
// Forward-compat: while `TELEMETRY_ENABLED` is `false` in the source, the
// bundler dead-code-eliminates the entire transport block, so the
// `BUILD_IDENTITY = "..."` and `WRITE_KEY = "phc_..."` constants do not
// appear in the binary even when env vars are correctly injected. This
// script reads the source flag at build time and skips the assertion in
// that case — the moment the flag flips to `true` (PR #1385), every
// subsequent release is enforced.
//
// Cross-platform note: written in Node so it runs identically on the Mac,
// Linux, and Windows release runners. Locating `app.asar` via `fs.readdir`
// (instead of POSIX `find`) avoids depending on Git Bash on Windows.

import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

function findAsar(rootDir) {
  // Why: electron-builder writes exactly one `app.asar` per platform target
  // (mac → `dist/mac-*/Orca.app/Contents/Resources/app.asar`, linux →
  // `dist/linux-unpacked/resources/app.asar`, win → `dist/win-unpacked/
  // resources/app.asar`). Recurse and return all matches; refuse if multiple
  // are found, since that means the pack produced more than one app payload
  // and the verify needs per-pack scoping.
  const matches = []
  const stack = [rootDir]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (entry.isFile() && entry.name === 'app.asar') {
        matches.push(fullPath)
      }
    }
  }
  return matches
}

const distDir = process.argv[2] ?? 'dist'
if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
  console.error(`::error::dist directory not found at ${distDir}`)
  process.exit(1)
}

// Why: with `TELEMETRY_ENABLED = false` in source, Rollup eliminates the
// transport block and the substituted constants vanish from the binary.
// Verifying in that state would always fail. Read the flag from source
// instead of inferring it from the build, so the gate cannot drift.
const clientSrc = readFileSync('src/main/telemetry/client.ts', 'utf8')
const enabledMatch = /^const\s+TELEMETRY_ENABLED\s*=\s*(true|false)/m.exec(clientSrc)
if (!enabledMatch) {
  console.error('::error::could not parse TELEMETRY_ENABLED flag from src/main/telemetry/client.ts')
  process.exit(1)
}
if (enabledMatch[1] === 'false') {
  console.log(
    'TELEMETRY_ENABLED is false in source — transport is dead-code-eliminated, ' +
      'so the BUILD_IDENTITY/WRITE_KEY constants are not expected in the binary. ' +
      'Skipping asar grep. (Once the flag flips to true, this verify becomes enforcing.)'
  )
  process.exit(0)
}

const asarMatches = findAsar(distDir)
if (asarMatches.length === 0) {
  console.error(`::error::could not locate app.asar under ${distDir}`)
  process.exit(1)
}
if (asarMatches.length > 1) {
  console.error(`::error::expected exactly one app.asar under ${distDir}, found ${asarMatches.length}:`)
  for (const m of asarMatches) {
    console.error(`  - ${m}`)
  }
  process.exit(1)
}
const asarPath = asarMatches[0]
console.log(`Verifying telemetry constants in ${asarPath}`)

const extractDir = mkdtempSync(join(tmpdir(), 'orca-asar-verify-'))
// Why `shell: true` on Windows: `npx` resolves to a `.cmd` shim there, and
// Node's `execFileSync` refuses to launch `.cmd` files without a shell.
execFileSync('npx', ['--yes', 'asar', 'extract', asarPath, extractDir], {
  stdio: 'inherit',
  shell: process.platform === 'win32'
})

const indexPath = join(extractDir, 'out', 'main', 'index.js')
if (!existsSync(indexPath)) {
  console.error(`::error::extracted asar is missing out/main/index.js at ${indexPath}`)
  process.exit(1)
}

const indexJs = readFileSync(indexPath, 'utf8')

// Why these regexes: electron-vite's `define` block substitutes the bare
// identifiers `ORCA_BUILD_IDENTITY` and `ORCA_POSTHOG_WRITE_KEY` with their
// JSON-stringified values at build time. `src/main/telemetry/client.ts`
// then assigns those into module-local consts named `BUILD_IDENTITY` and
// `WRITE_KEY`. Rollup's minifier preserves the `const NAME = "literal"`
// shape after dead-code elimination collapses the `typeof X !== 'undefined'`
// guard. Match that exact emitted shape so a regression — e.g. the env
// var unset and the substitution falling back to literal `null` — fails
// the grep instead of slipping through as a falsy-but-stringy value.
const buildIdentityMatch = /const\s+BUILD_IDENTITY\s*=\s*"(rc|stable)"/.exec(indexJs)
const writeKeyMatch = /const\s+WRITE_KEY\s*=\s*"(phc_[A-Za-z0-9]+)"/.exec(indexJs)

if (!buildIdentityMatch) {
  console.error('::error::BUILD_IDENTITY constant missing or unexpected value in shipped binary')
  const sample = indexJs.match(/.*BUILD_IDENTITY.*/g)?.slice(0, 5) ?? []
  for (const line of sample) {
    console.error(`  ${line}`)
  }
  process.exit(1)
}
if (!writeKeyMatch) {
  console.error('::error::PostHog WRITE_KEY missing from shipped binary')
  process.exit(1)
}

console.log(
  `Telemetry constants verified: BUILD_IDENTITY="${buildIdentityMatch[1]}", ` +
    `WRITE_KEY="${writeKeyMatch[1].slice(0, 8)}..." (length=${writeKeyMatch[1].length})`
)
