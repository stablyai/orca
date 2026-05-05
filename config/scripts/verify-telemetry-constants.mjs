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
// We grep the packed `app.asar`'s `out/main/*.js` files (the same files
// that the runtime loads) rather than the unpacked `out/`. asar is a
// tar-like archive that doesn't transform contents, so the two are
// byte-equivalent today — but verifying the asar protects against any
// future config change that excludes the main bundle from the package.
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
// Reading the asar via the programmatic `@electron/asar` API (instead of
// shelling out to `npx asar`) avoids both a network fetch on every run
// and the Windows `.cmd`-shim/`shell: true` workaround.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// Why @electron/asar: canonical replacement for the deprecated `asar` package.
// It's transitively available via electron-builder (and pnpm's
// `shamefully-hoist=true` in `.npmrc` flattens it into the root
// `node_modules`). If electron-builder ever drops it, promote this to a
// direct devDependency in package.json.
import { extractFile, listPackage } from '@electron/asar'

// Why resolve from import.meta.url instead of cwd: a release runner (or a
// developer debugging locally) may invoke this script from a non-root cwd.
// Resolving relative to the script's own location turns a misleading
// "could not parse TELEMETRY_ENABLED flag" parse error into a clear
// file-not-found error, and decouples the script from the caller's cwd.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function findAsar(rootDir) {
  // Why: electron-builder produces one `app.asar` per platform-arch combo.
  // Linux/Windows targets ship one (`dist/linux-unpacked/resources/app.asar`,
  // `dist/win-unpacked/resources/app.asar`); macOS dual-arch ships two
  // (`dist/mac/Orca.app/Contents/Resources/app.asar` for x64,
  // `dist/mac-arm64/Orca.app/Contents/Resources/app.asar` for arm64) because
  // `electron-builder.config.cjs` declares `arch: ['x64', 'arm64']`. Both
  // arches share the same JS bundle through electron-vite's single `main`
  // build, so the constants are identical across them — but verifying every
  // match catches the regression where one arch's pack drifts (e.g. a future
  // arch-specific bundle split that forgets to thread the `define` block).
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
const clientSrcPath = join(repoRoot, 'src/main/telemetry/client.ts')
const clientSrc = readFileSync(clientSrcPath, 'utf8')
const enabledMatch = /^const\s+TELEMETRY_ENABLED\s*=\s*(true|false)/m.exec(clientSrc)
if (!enabledMatch) {
  console.error(`::error::could not parse TELEMETRY_ENABLED flag from ${clientSrcPath}`)
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
console.log(`Found ${asarMatches.length} app.asar payload(s) under ${distDir}:`)
for (const m of asarMatches) {
  console.log(`  - ${m}`)
}

// Why these regexes: electron-vite's `define` block substitutes the bare
// identifiers `ORCA_BUILD_IDENTITY` and `ORCA_POSTHOG_WRITE_KEY` with their
// JSON-stringified values at build time. `src/main/telemetry/client.ts`
// then assigns those into module-local consts named `BUILD_IDENTITY` and
// `WRITE_KEY`. electron-vite's main config is not minified (Vite default for
// Electron main builds), so Rollup emits the substituted constants verbatim
// as `const BUILD_IDENTITY = "stable";`. Match that exact emitted shape so a
// regression — e.g. the env var unset and the substitution falling back to
// literal `null` — fails the grep instead of slipping through as a falsy-
// but-stringy value. NOTE: if `build.minify` is ever enabled on the main
// bundle, esbuild/terser will rename top-level consts and this regex must
// be revisited (or replaced with a value-based assertion).
//
// WRITE_KEY char class includes `_` and `-` because PostHog project API
// keys use URL-safe base64 alphabet beyond `phc_`.
const BUILD_IDENTITY_RE = /const\s+BUILD_IDENTITY\s*=\s*"(rc|stable)"/
const WRITE_KEY_RE = /const\s+WRITE_KEY\s*=\s*"(phc_[A-Za-z0-9_-]+)"/

function verifyAsar(asarPath) {
  console.log(`Verifying ${asarPath}`)

  // Why list-then-extract (not a hardcoded path): future electron-vite
  // chunking (e.g. `manualChunks`) could move the constants out of
  // `out/main/index.js` into `out/main/chunks/telemetry-XYZ.js`. Enumerate
  // every `.js` under `out/main/` and concatenate before grepping so the
  // verify is resilient to chunking. listPackage builds entries with the
  // host `path` module, so on Windows runners separators are backslashes
  // (`\out\main\index.js`); normalize to forward slashes for the filter
  // and strip the leading separator (of either kind) before passing the
  // entry to extractFile.
  const allEntries = listPackage(asarPath)
  const mainJsEntries = allEntries.filter((p) => {
    const normalized = p.replace(/\\/g, '/').replace(/^\/+/, '')
    return normalized.startsWith('out/main/') && normalized.endsWith('.js')
  })

  if (mainJsEntries.length === 0) {
    console.error(`::error::no .js files found under out/main/ in ${asarPath}`)
    return null
  }

  const indexJs = mainJsEntries
    .map((entry) => {
      // extractFile uses the host path module internally; pass the
      // host-separator path with the leading separator stripped.
      const internal = entry.replace(/^[\\/]+/, '')
      return extractFile(asarPath, internal).toString('utf8')
    })
    .join('\n')

  const buildIdentityMatch = BUILD_IDENTITY_RE.exec(indexJs)
  const writeKeyMatch = WRITE_KEY_RE.exec(indexJs)

  if (!buildIdentityMatch) {
    console.error(
      `::error::BUILD_IDENTITY constant missing or unexpected value in ${asarPath}`
    )
    const sample = indexJs.match(/.{0,80}BUILD_IDENTITY.{0,80}/g)?.slice(0, 5) ?? []
    for (const line of sample) {
      console.error(`  ${line.slice(0, 200)}`)
    }
    return null
  }
  if (!writeKeyMatch) {
    console.error(`::error::PostHog WRITE_KEY missing from ${asarPath}`)
    const sample = indexJs.match(/.{0,80}WRITE_KEY.{0,80}/g)?.slice(0, 5) ?? []
    for (const line of sample) {
      console.error(`  ${line.slice(0, 200)}`)
    }
    return null
  }

  return { asarPath, buildIdentity: buildIdentityMatch[1], writeKey: writeKeyMatch[1] }
}

// Why verify every match (not just the first): macOS dual-arch produces one
// asar per arch from the same `out/main` bundle, so identical constants are
// expected — but if a future change introduces an arch-specific bundle split
// (or a per-arch `electron-vite build` invocation) that forgets to thread
// the `define` values, only one of the asars would carry the constants and
// the broken arch would ship transmitting nothing. Looping is cheap insurance
// against that class of regression. We additionally require every asar to
// agree on the BUILD_IDENTITY and WRITE_KEY values — a mismatch means the
// matrix shipped inconsistent build-identity claims, or (worse) per-arch
// PostHog keys that would split events across projects, both of which are
// release bugs.
const results = []
for (const asarPath of asarMatches) {
  const result = verifyAsar(asarPath)
  if (!result) {
    process.exit(1)
  }
  results.push(result)
}

const distinctIdentities = new Set(results.map((r) => r.buildIdentity))
if (distinctIdentities.size > 1) {
  console.error(
    `::error::asars disagree on BUILD_IDENTITY: ${[...distinctIdentities].join(', ')}`
  )
  for (const r of results) {
    console.error(`  - ${r.asarPath}: ${r.buildIdentity}`)
  }
  process.exit(1)
}

const distinctWriteKeys = new Set(results.map((r) => r.writeKey))
if (distinctWriteKeys.size > 1) {
  console.error(`::error::asars disagree on WRITE_KEY across arches`)
  for (const r of results) {
    console.error(`  - ${r.asarPath}: ${r.writeKey.slice(0, 8)}... (length=${r.writeKey.length})`)
  }
  process.exit(1)
}

const [first] = results
console.log(
  `Telemetry constants verified across ${results.length} asar(s): ` +
    `BUILD_IDENTITY="${first.buildIdentity}", ` +
    `WRITE_KEY="${first.writeKey.slice(0, 8)}..." (length=${first.writeKey.length})`
)
