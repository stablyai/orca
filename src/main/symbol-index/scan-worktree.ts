import { readdir } from 'node:fs/promises'
import path from 'node:path'

// ids must match detectLanguage(): .tsx collapses onto 'typescript'.
const EXT_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java'
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', 'dist', 'out', 'build'])

export function languageIdForPath(absPath: string): string | null {
  return EXT_TO_LANGUAGE[path.extname(absPath).toLowerCase()] ?? null
}

export async function listIndexableFiles(
  root: string,
  opts: { maxFiles: number; maxDirs?: number }
): Promise<string[]> {
  // Why: maxFiles alone never trips when a tree has many directories but few
  // (or zero) indexable files (e.g. millions of empty dirs), so traversal
  // must also be bounded by directories visited.
  const maxDirs = opts.maxDirs ?? 100_000
  const out: string[] = []
  const stack: string[] = [root]
  let dirsVisited = 0
  while (stack.length > 0 && out.length < opts.maxFiles && dirsVisited < maxDirs) {
    const dir = stack.pop()!
    dirsVisited++
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (out.length >= opts.maxFiles) {
        break
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
          continue
        }
        stack.push(path.join(dir, entry.name))
      } else if (entry.isFile()) {
        const abs = path.join(dir, entry.name)
        if (languageIdForPath(abs)) {
          out.push(abs)
        }
      }
    }
  }
  return out
}
