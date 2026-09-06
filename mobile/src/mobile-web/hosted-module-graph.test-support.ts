import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const mobileRoot = fileURLToPath(new URL('../..', import.meta.url))
export const hostedRoot = join(mobileRoot, 'host-web-app')
export const nativeRoot = join(mobileRoot, 'app')
// Metro/web resolution order: a `.web` sibling shadows the native module inside the page bundle.
const MODULE_EXTENSIONS = ['.web.tsx', '.web.ts', '.tsx', '.ts']
const RELATIVE_IMPORT = /from\s+['"](\.[^'"]+)['"]/g

/** Every module the given roots pull in, following relative imports only. Defaults to every
 * hosted route file, so the walk covers the whole page bundle rather than a hand-kept list. */
export function hostedModuleGraph(roots?: string[]): string[] {
  const visited = new Set<string>()
  const pending = roots ?? listFiles(hostedRoot).filter((path) => path.endsWith('.tsx'))
  while (pending.length > 0) {
    const modulePath = pending.pop()
    if (!modulePath || visited.has(modulePath) || modulePath.includes('.test.')) {
      continue
    }
    visited.add(modulePath)
    const source = readFileSync(modulePath, 'utf8')
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      const resolved = resolveModule(dirname(modulePath), match[1]!)
      if (resolved) {
        pending.push(resolved)
      }
    }
  }
  return [...visited].sort()
}

export function listRoutes(root: string): string[] {
  return listFiles(root)
    .filter((path) => path.endsWith('.tsx') && !path.includes('.test.'))
    .map(
      (path) =>
        `/${relative(root, path)
          .replace(/\.tsx$/, '')
          .split(/[\\/]/)
          .join('/')}`
    )
    .map((route) => route.replace(/\/index$/, ''))
    .filter((route) => route !== '' && !route.includes('_layout'))
}

export function listFiles(root: string): string[] {
  const paths: string[] = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (!directory) {
      continue
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
      } else {
        paths.push(path)
      }
    }
  }
  return paths
}

function resolveModule(fromDirectory: string, specifier: string): string | null {
  const base = resolve(fromDirectory, specifier)
  for (const extension of MODULE_EXTENSIONS) {
    const candidate = `${base}${extension}`
    if (isFile(candidate)) {
      return candidate
    }
  }
  for (const extension of MODULE_EXTENSIONS) {
    const candidate = join(base, `index${extension}`)
    if (isFile(candidate)) {
      return candidate
    }
  }
  return null
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
