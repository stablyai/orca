#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Why: build:electron-vite cleans out/main and re-emits only its rollup input
// entries, so a CLI import of a main module that lacks a matching entry ships
// as a MODULE_NOT_FOUND crash (1.4.150-rc.1.perf shipped a dead CLI this way).
// This walks the compiled CLI's relative require() graph against the final
// out/ tree so the break fails the build instead of the user's first command.

const RELATIVE_REQUIRE_PATTERN = /\brequire\(\s*(["'])(\.{1,2}\/[^"']+)\1\s*\)/g

// Why: build:cli emits compiled specs into out/, but the shipped CLI never
// requires them — they run from src under vitest. Seeding the walk with them
// would fail the build on imports (e.g. main-side parity checks) that no user
// command can reach. They are still walked if a real entry pulls one in.
const COMPILED_SPEC_PATTERN = /\.(test|spec)\.js$/

function listJsFilesRecursively(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listJsFilesRecursively(entryPath))
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(entryPath)
    }
  }
  return files
}

/** Node CJS resolution for a relative specifier, limited to on-disk shapes tsc
 *  and rollup emit: exact file, `.js`/`.json` extension, or directory index. */
function resolveRelativeRequire(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate
    }
  }
  return null
}

/**
 * Walks every relative require() reachable from out/cli and asserts each target
 * resolves inside the final out/ tree. Returns the list of missing edges.
 */
export function verifyCliRequireResolution({
  projectDir = path.resolve(import.meta.dirname, '..', '..')
} = {}) {
  const outDir = path.join(projectDir, 'out')
  const cliDir = path.join(outDir, 'cli')
  if (!existsSync(cliDir)) {
    return { checkedFiles: 0, missing: [], skipped: true }
  }

  const queue = listJsFilesRecursively(cliDir).filter((file) => !COMPILED_SPEC_PATTERN.test(file))
  const visited = new Set(queue)
  const missing = []
  while (queue.length > 0) {
    const file = queue.pop()
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(RELATIVE_REQUIRE_PATTERN)) {
      const specifier = match[2]
      const resolved = resolveRelativeRequire(file, specifier)
      if (resolved === null) {
        missing.push({ from: path.relative(projectDir, file), specifier })
        continue
      }
      // Why: transitive edges matter — out/cli requires out/shared modules that
      // may themselves require paths electron-vite's clean step removed.
      if (resolved.endsWith('.js') && !visited.has(resolved)) {
        visited.add(resolved)
        queue.push(resolved)
      }
    }
  }
  return { checkedFiles: visited.size, missing, skipped: false }
}

function main() {
  const result = verifyCliRequireResolution()
  if (result.skipped) {
    console.log('[cli-requires] out/cli not present; skipping (run build:cli first)')
    return
  }
  if (result.missing.length > 0) {
    console.error(
      `[cli-requires] ${result.missing.length} relative require(s) in the compiled CLI graph do not resolve in out/:`
    )
    for (const edge of result.missing) {
      console.error(`  ${edge.from} -> require('${edge.specifier}')`)
    }
    console.error(
      '[cli-requires] A CLI import of an out/main module needs a matching rollup input entry in electron.vite.config.ts, or the module belongs in src/shared.'
    )
    process.exit(1)
  }
  console.log(
    `[cli-requires] verified ${result.checkedFiles} compiled module(s), all requires resolve`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
