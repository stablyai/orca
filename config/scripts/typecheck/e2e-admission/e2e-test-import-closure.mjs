import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*'(\.[^']+)'/g

/** The entry files plus every `tests/` file they import, transitively through relative imports. */
export function testImportClosure(projectDir, entries) {
  const seen = new Set()
  const pending = [...entries]
  while (pending.length > 0) {
    const file = pending.pop()
    if (seen.has(file)) {
      continue
    }
    seen.add(file)
    const source = readFileSync(join(projectDir, file), 'utf8')
    for (const [, specifier] of source.matchAll(RELATIVE_IMPORT)) {
      // Repo-relative with `/` on every platform, so `tests/` prefixes and route regexes apply.
      const base = relative(projectDir, join(projectDir, dirname(file), specifier))
        .split(sep)
        .join('/')
      const resolved = [base, `${base}.ts`, `${base}.tsx`].find(
        (candidate) => /\.tsx?$/.test(candidate) && existsSync(join(projectDir, candidate))
      )
      if (resolved?.startsWith('tests/')) {
        pending.push(resolved)
      }
    }
  }
  return [...seen]
}
