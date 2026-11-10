import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Why: import.meta.url, not dirname — electron-vite's config bundle rewrites only the former.
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

export const UNCOMPILED_LIST = 'config/react-compiler-uncompiled-files.txt'
// Hand-kept list plus every file still in a hazard ratchet; compiled, these would run differently.
export const UNCOMPILED_FILE_LISTS = [
  UNCOMPILED_LIST,
  'config/render-path-translate-baseline.txt',
  'config/react-compiler-hazard-baseline.txt'
]

/** Repo-relative paths from a list or count baseline: `[count ]path[#detail][  # note]`. */
export function parseListedFiles(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) =>
      line
        .replace(/^\d+\s+/, '')
        .split('#')[0]
        .trim()
    )
}

export function readListedFiles(list, root = REPO_ROOT) {
  return parseListedFiles(readFileSync(resolve(root, list), 'utf8'))
}

export function reactCompilerExcludedFiles(root = REPO_ROOT) {
  return [...new Set(UNCOMPILED_FILE_LISTS.flatMap((list) => readListedFiles(list, root)))]
}
