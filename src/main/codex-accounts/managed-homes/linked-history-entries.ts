import type { Stats } from 'node:fs'
import { lstat, readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, sep } from 'node:path'
import { errnoCodeOrUnknown } from '../../../shared/errors/errno-code'

const MAX_HISTORY_LINK_HOPS = 40

async function lstatIfPresent(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  } catch (error) {
    const code = errnoCodeOrUnknown(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null
    }
    throw error
  }
}

function pathComponents(path: string): string[] {
  return path.slice(parse(path).root.length).split(/[\\/]/)
}

/**
 * The top-level entries a linked history.jsonl passes through inside the home, one path component
 * at a time: every link and folder on the way and the file it reaches, so removal keeps them all.
 * Throws when a step can't be read, so removal stops instead of deleting what it couldn't follow.
 */
export async function linkedHistoryEntries(home: string): Promise<Set<string>> {
  const entries = new Set<string>()
  if (!(await lstatIfPresent(join(home, 'history.jsonl')))?.isSymbolicLink()) {
    return entries
  }
  const realHome = await realpath(home)
  const keepTopEntry = (path: string): void => {
    for (const root of [realHome, home]) {
      const inside = relative(root, path)
      const first = inside.split(sep)[0]
      if (inside && first !== '..' && !isAbsolute(inside)) {
        entries.add(first)
        return
      }
    }
  }
  let dir = realHome
  let pending = ['history.jsonl']
  let hops = 0
  while (pending.length > 0) {
    const name = pending.shift()
    if (!name || name === '.') {
      continue
    }
    if (name === '..') {
      dir = dirname(dir)
      continue
    }
    const path = join(dir, name)
    keepTopEntry(path)
    const stats = await lstatIfPresent(path)
    if (!stats) {
      // Nothing exists past a missing step, so nothing more needs keeping.
      return entries
    }
    if (!stats.isSymbolicLink()) {
      dir = path
      continue
    }
    if (++hops > MAX_HISTORY_LINK_HOPS) {
      throw new Error('Too many links on the way to the prompt history')
    }
    const target = await readlink(path)
    if (isAbsolute(target)) {
      dir = parse(target).root
    }
    pending = [...pathComponents(target), ...pending]
  }
  return entries
}

/**
 * The same walk for a WSL home, as bash lines run with the home in $home: collects the entries into
 * $history_entries ("/a/b/"), and exits nonzero on any step it can't read.
 */
export const LINKED_HISTORY_ENTRIES_SCRIPT = [
  'real_home=$(cd -P -- "$home" && pwd) || exit 1',
  'history_entries=/',
  'keep_entry() {',
  '  for root in "$real_home" "$home"; do',
  '    case "$1" in "$root"/?*) inside=${1#"$root"/}; first=${inside%%/*}',
  '      case "$first" in .|..) ;; *) history_entries="$history_entries$first/"; return ;; esac ;; esac',
  '  done',
  '}',
  'if [ -L "$home/history.jsonl" ]; then',
  '  dir=$real_home; rest=history.jsonl; hops=0',
  '  while [ -n "$rest" ]; do',
  '    case "$rest" in */*) name=${rest%%/*}; rest=${rest#*/} ;; *) name=$rest; rest= ;; esac',
  '    case "$name" in "" | .) continue ;; ..) dir=${dir%/*}; dir=${dir:-/}; continue ;; esac',
  '    next=${dir%/}/$name',
  '    keep_entry "$next"',
  '    if [ -L "$next" ]; then',
  '      hops=$((hops + 1)); [ "$hops" -le 40 ] || exit 1',
  '      target=$(readlink -- "$next") || exit 1',
  '      case "$target" in /*) dir=/ ;; esac',
  '      rest=$target${rest:+/$rest}',
  '    elif [ -e "$next" ]; then dir=$next',
  '    elif [ -x "$dir" ]; then break',
  '    else exit 1',
  '    fi',
  '  done',
  'fi'
]
