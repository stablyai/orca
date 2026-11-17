import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Every `orca` call loads this graph; zod alone costs ~25 ms warm (~150 ms cold) to resolve.
const ENTRY = resolve(__dirname, 'index.ts')
const STATIC_IMPORT =
  /^\s*(?:import|export)\s+(?!type\b)([^'";]*?)\s*from\s*['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm

function loadsAtRuntime(clause: string): boolean {
  const braces = /^\{([^}]*)\}$/s.exec(clause.trim())
  return !braces || braces[1].split(',').some((name) => name.trim() && !/^type\s/.test(name.trim()))
}

function resolveLocal(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec.replace(/\.js$/, ''))
  return (
    [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile()
    ) ?? null
  )
}

function eagerPackages(entry: string): { packages: Set<string>; via: Map<string, string> } {
  const seen = new Set([entry])
  const packages = new Set<string>()
  const via = new Map<string, string>()
  const queue = [entry]
  for (let file = queue.shift(); file; file = queue.shift()) {
    for (const match of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) {
      const spec = match[2] ?? match[3]
      if (match[1] !== undefined && !loadsAtRuntime(match[1])) {
        continue
      }
      if (!spec.startsWith('.')) {
        packages.add(spec)
        via.set(spec, file)
        continue
      }
      const next = resolveLocal(file, spec)
      if (next && !seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return { packages, via }
}

describe('orca CLI eager import graph', () => {
  it('does not load zod', () => {
    const { packages, via } = eagerPackages(ENTRY)
    expect(
      [...packages]
        .filter((name) => name === 'zod' || name.startsWith('zod/'))
        .map((name) => via.get(name))
    ).toEqual([])
  })
})
