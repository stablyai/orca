import { lstat, readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const MAX_HISTORY_LINK_HOPS = 40

// The top-level entries a linked history.jsonl reaches inside the home: every link on the way and
// the file it resolves to, so removal keeps them all.
export async function linkedHistoryEntries(home: string): Promise<Set<string>> {
  const entries = new Set<string>()
  const roots = [home, await realpath(home).catch(() => home)]
  const keepTopEntry = (path: string): void => {
    for (const root of roots) {
      const inside = relative(root, path)
      const first = inside.split(sep)[0]
      if (inside && first !== '..' && !isAbsolute(inside)) {
        entries.add(first)
        return
      }
    }
  }
  let path = join(home, 'history.jsonl')
  for (let hop = 0; hop < MAX_HISTORY_LINK_HOPS; hop++) {
    const stats = await lstat(path).catch(() => null)
    if (!stats?.isSymbolicLink()) {
      break
    }
    const next = await readlink(path).catch(() => null)
    if (next === null) {
      break
    }
    path = resolve(dirname(path), next)
    keepTopEntry(path)
  }
  const target = await realpath(join(home, 'history.jsonl')).catch(() => null)
  if (target) {
    keepTopEntry(target)
  }
  return entries
}
