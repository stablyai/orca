import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(import.meta.dirname, '../../..')
// Each folder has one entry module, plus a DB-only one so the DB layer never loads rpc code.
// The two folders are one frozen unit and may import each other directly.
const DB_LAYER = 'main/runtime/orchestration/db/'
const LEGACY_ENTRIES_BY_FOLDER = {
  'main/runtime/orchestration/legacy-remote/': {
    entry: 'main/runtime/orchestration/legacy-remote/legacy-remote.ts',
    dbEntry: 'main/runtime/orchestration/legacy-remote/legacy-remote-db-methods.ts'
  },
  'main/runtime/orchestration/legacy-remote-home/': {
    entry: 'main/runtime/orchestration/legacy-remote-home/legacy-remote-home.ts',
    dbEntry: 'main/runtime/orchestration/legacy-remote-home/legacy-remote-home-db-methods.ts'
  }
}
// Legacy starts load the worker list, so it bypasses the entry module to stay out of an import cycle.
const DIRECT_IMPORTS = new Set([
  'main/runtime/rpc/methods/orchestration/worker/worker-list-projection.ts -> main/runtime/orchestration/legacy-remote-home/federated-fleet-snapshot.ts'
])
const IMPORT_SPECIFIER =
  /(?:from\s+|import\s*\(\s*|import\s+|require\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g

function productionSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') {
        productionSources(path, out)
      }
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|spec)\.|test-support|harness/.test(entry.name)
    ) {
      out.push(path)
    }
  }
  return out
}

function srcPath(file: string): string {
  return relative(SRC, file).split(sep).join('/')
}

function resolveSpecifier(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier)
  return [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile()
  )
}

describe('legacy remote-attachment folders', () => {
  it('are imported from outside only through their entry module', () => {
    const violations: string[] = []
    const entryImporters = new Set<string>()
    for (const file of productionSources(SRC)) {
      const from = srcPath(file)
      for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_SPECIFIER)) {
        const target = resolveSpecifier(file, match[1])
        if (!target) {
          continue
        }
        const to = srcPath(target)
        for (const [folder, { entry, dbEntry }] of Object.entries(LEGACY_ENTRIES_BY_FOLDER)) {
          if (
            to.startsWith(folder) &&
            !Object.keys(LEGACY_ENTRIES_BY_FOLDER).some((f) => from.startsWith(f))
          ) {
            if (to === entry || (to === dbEntry && from.startsWith(DB_LAYER))) {
              entryImporters.add(`${from} -> ${to}`)
            } else if (!DIRECT_IMPORTS.has(`${from} -> ${to}`)) {
              violations.push(`${from} -> ${to}`)
            }
          }
        }
      }
    }
    expect(violations).toEqual([])
    // The capability branch on each side: legacy worker starts and the legacy federation methods.
    expect(entryImporters).toContain(
      'main/runtime/rpc/methods/orchestration/worker/workers.ts -> main/runtime/orchestration/legacy-remote-home/legacy-remote-home.ts'
    )
    expect(entryImporters).toContain(
      'main/runtime/rpc/methods/orchestration/federation/federation-methods.ts -> main/runtime/orchestration/legacy-remote/legacy-remote.ts'
    )
  })
})
