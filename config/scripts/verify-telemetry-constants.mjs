#!/usr/bin/env node

// Verify injected identity/key in every packed app.asar before publishing draft; unpacked out/ alone cannot prove shipped telemetry (#1385).
// Skip only when source TELEMETRY_ENABLED is false and DCE removes constants. Use Node asar API across platforms, avoiding network/.cmd shell shims.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
// Use electron-builder’s @electron/asar; if no longer hoisted transitively, declare direct dependency.
import { extractFile, listPackage } from '@electron/asar'
import {
  BUILD_IDENTITY_RE,
  MINIFIED_TELEMETRY_RE,
  WRITE_KEY_RE
} from './telemetry-bundle-constant-patterns.mjs'

// Resolve source relative to script, not caller cwd, so release/local invocations read same telemetry flag.
const repoRoot = resolve(import.meta.dirname, '..', '..')

function findAsar(rootDir) {
  // Check every platform/arch asar even with shared JS bundle; future per-arch split could lose injected constants on one slice.
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

// Read source flag: false DCE removes constants, so absence in output cannot distinguish disabled telemetry from failed injection.
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

// Match define-injected JSON values assigned to BUILD_IDENTITY/WRITE_KEY, allowing const or lowered var.

function verifyAsar(asarPath) {
  console.log(`Verifying ${asarPath}`)

  // List all out/main JS chunks before extraction so manualChunks cannot hide telemetry. Normalize Windows separators for filter, strip leading separator for API.
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
      // extractFile expects host separators without leading separator.
      const internal = entry.replace(/^[\\/]+/, '')
      return extractFile(asarPath, internal).toString('utf8')
    })
    .join('\n')

  const buildIdentityMatch = BUILD_IDENTITY_RE.exec(indexJs)
  const writeKeyMatch = WRITE_KEY_RE.exec(indexJs)
  const minifiedTelemetryMatch = MINIFIED_TELEMETRY_RE.exec(indexJs)

  // Production Rolldown may rename locals; adjacent injected identity/key still identifies declaration.
  const verifiedIdentity = buildIdentityMatch?.[1] ?? minifiedTelemetryMatch?.[1]
  const verifiedWriteKey = writeKeyMatch?.[1] ?? minifiedTelemetryMatch?.[2]

  if (!verifiedIdentity) {
    console.error(`::error::BUILD_IDENTITY constant missing or unexpected value in ${asarPath}`)
    const sample = indexJs.match(/.{0,80}BUILD_IDENTITY.{0,80}/g)?.slice(0, 5) ?? []
    for (const line of sample) {
      console.error(`  ${line.slice(0, 200)}`)
    }
    return null
  }
  if (!verifiedWriteKey) {
    console.error(`::error::PostHog WRITE_KEY missing from ${asarPath}`)
    const sample = indexJs.match(/.{0,80}WRITE_KEY.{0,80}/g)?.slice(0, 5) ?? []
    for (const line of sample) {
      console.error(`  ${line.slice(0, 200)}`)
    }
    return null
  }

  return { asarPath, buildIdentity: verifiedIdentity, writeKey: verifiedWriteKey }
}

// Require every asar to carry identical identity/key; checking first alone misses per-arch define drift and split analytics projects.
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
  console.error(`::error::asars disagree on BUILD_IDENTITY: ${[...distinctIdentities].join(', ')}`)
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
