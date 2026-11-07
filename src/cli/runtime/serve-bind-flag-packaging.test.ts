import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(__dirname, '../..')
const RUNTIME_IMPORT = /^(?:import|export)\s+(?!type\b)[^'"]*?from\s+'(\.[^']+)'/gm

/** Relative runtime imports reachable from an entry; type-only imports are erased at build time. */
function runtimeImportClosure(entry: string): string[] {
  const seen = new Set<string>()
  const pending = [resolve(SRC, entry)]
  while (pending.length > 0) {
    const file = pending.pop()!
    if (seen.has(file)) {
      continue
    }
    seen.add(file)
    for (const match of readFileSync(file, 'utf8').matchAll(RUNTIME_IMPORT)) {
      const base = resolve(dirname(file), match[1].replace(/\.js$/, ''))
      const target = [`${base}.ts`, join(base, 'index.ts')].find((candidate) =>
        existsSync(candidate)
      )
      if (target) {
        pending.push(target)
      }
    }
  }
  return [...seen].map((file) => relative(SRC, file).split(sep).join('/'))
}

describe('serve --bind in the packaged CLI', () => {
  // The packaged app ships out/cli and out/shared but not out/main/orcad, so a CLI import of
  // main/orcad fails the packaged runtime-import check and would not load.
  it.each(['cli/runtime/serve-bind-flag.ts', 'shared/serve-option-validation.ts'])(
    '%s loads only CLI and shared modules',
    (entry) => {
      const outside = runtimeImportClosure(entry).filter(
        (file) => !file.startsWith('cli/') && !file.startsWith('shared/')
      )
      expect(outside).toEqual([])
    }
  )
})
