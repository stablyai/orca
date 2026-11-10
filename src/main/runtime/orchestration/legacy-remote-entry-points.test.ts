import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(import.meta.dirname, '../../..')
// Each folder has one entry module, plus a DB-only one so the DB layer never loads rpc code.
const LEGACY_ENTRIES_BY_FOLDER = {
  'main/runtime/orchestration/legacy-remote/': [
    'main/runtime/orchestration/legacy-remote/legacy-remote.ts',
    'main/runtime/orchestration/legacy-remote/legacy-remote-db-methods.ts'
  ],
  'main/runtime/orchestration/legacy-remote-home/': [
    'main/runtime/orchestration/legacy-remote-home/legacy-remote-home.ts',
    'main/runtime/orchestration/legacy-remote-home/legacy-remote-home-db-methods.ts'
  ]
}
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
        for (const [folder, entries] of Object.entries(LEGACY_ENTRIES_BY_FOLDER)) {
          if (to.startsWith(folder) && !from.startsWith(folder)) {
            if (entries.includes(to)) {
              entryImporters.add(`${from} -> ${to}`)
            } else {
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
