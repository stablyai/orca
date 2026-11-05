import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Alias, Plugin } from 'vite'

// Why: Vitest keys a cached transform by its own source, so a new sibling such as
// `foo.ts` beside `foo/index.ts` would keep serving the old resolution. Fold every
// candidate a literal specifier could resolve to into the key instead.
const LITERAL = /(?=(['"`])([^'"`\n]*)\1)/g
const DYNAMIC_IMPORT = /\bimport\s*\(\s*/g
const PLAIN_LITERAL_ARGUMENT = /^(['"`])[^'"`\n$]*\1\s*[,)]/

// Vite expands template/concatenated dynamic imports into globs over directory contents.
export function hasExpandedImport(source: string): boolean {
  if (/\bimport\.meta\.glob\b/.test(source)) {
    return true
  }
  for (const match of source.matchAll(DYNAMIC_IMPORT)) {
    const rest = source.slice(match.index + match[0].length)
    if (/^['"`]/.test(rest) && !PLAIN_LITERAL_ARGUMENT.test(rest)) {
      return true
    }
  }
  return false
}

function applyAlias(specifier: string, aliases: readonly Alias[]): string | undefined {
  for (const { find, replacement } of aliases) {
    if (typeof find === 'string') {
      if (specifier === find || specifier.startsWith(`${find}/`)) {
        return replacement + specifier.slice(find.length)
      }
    } else if (find.test(specifier)) {
      return specifier.replace(find, replacement)
    }
  }
  return undefined
}

export function createResolutionFingerprint(root: string, aliases: readonly Alias[]) {
  const listings = new Map<string, readonly string[]>()
  const list = (dir: string): readonly string[] => {
    let names = listings.get(dir)
    if (!names) {
      try {
        // Directories carry a trailing slash so a file/directory swap also changes the key.
        names = readdirSync(dir, { withFileTypes: true })
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
          .sort()
      } catch {
        names = []
      }
      listings.set(dir, names)
    }
    return names
  }
  // Outside-root strings (e.g. '/tmp') are not module specifiers here and their listings churn.
  const insideRoot = (path: string) => {
    const rel = relative(root, path)
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  }
  // Every file Vite could pick for `base`: same-stem siblings, plus index/package.json if a directory.
  const candidates = (base: string): string => {
    const dir = dirname(base)
    const stem = basename(base).split('.')[0]
    const parts: string[] = []
    for (const name of list(dir).filter((entry) => entry.startsWith(stem))) {
      parts.push(name)
      if (name.endsWith('/')) {
        const path = join(dir, name)
        const inner = list(path)
        const entries = inner.filter((entry) => /^(?:index\.|package\.json$)/.test(entry))
        parts.push(`[${entries.join(',')}]`)
        if (inner.includes('package.json')) {
          parts.push(readFileSync(join(path, 'package.json'), 'utf8'))
        }
      }
    }
    return `${relative(root, base)}:${parts.join(',')}`
  }
  return (id: string, source: string): string => {
    const importerDir = dirname(id.split('?')[0])
    const seen = new Set<string>()
    for (const [, , literal] of source.matchAll(LITERAL)) {
      const specifier = literal.split(/[?#]/)[0]
      let target: string | undefined
      if (specifier === '.' || specifier === '..' || /^\.{1,2}\//.test(specifier)) {
        target = resolve(importerDir, specifier)
      } else if (specifier.startsWith('/')) {
        target = specifier.startsWith(root) ? specifier : join(root, specifier)
      } else {
        const aliased = applyAlias(specifier, aliases)
        target = aliased && isAbsolute(aliased) ? aliased : undefined
      }
      if (target && insideRoot(target)) {
        seen.add(target)
      }
    }
    return [...seen].sort().map(candidates).join('\n')
  }
}

export function moduleCacheResolutionKey(): Plugin {
  return {
    name: 'module-cache-resolution-key',
    configureVitest({ project, defineCacheKeyGenerator }) {
      const config = project.vite.config
      const fingerprint = createResolutionFingerprint(config.root, config.resolve.alias)
      defineCacheKeyGenerator(({ id, sourceCode }) =>
        hasExpandedImport(sourceCode) ? false : fingerprint(id, sourceCode)
      )
    }
  }
}
