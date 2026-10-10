import type {
  SkillDirectoryEntry,
  SkillFilesystemEntryKind,
  SkillPathInspection
} from '../skill-install-filesystem'

/**
 * Guest-side enumeration for path-based skill deletion.
 *
 * Both scripts take every path as a positional argument and emit one
 * NUL-delimited stream, because the delete plan needs the whole discovery root
 * set at once and one `wsl.exe` boot per root is the cost this shape avoids.
 * Records are keyed by argument index rather than by path so the caller rebuilds
 * its map under the exact strings it passed in, with no path round-tripping.
 */
export const WSL_LIST_ENTRIES_SCRIPT = [
  'set -u',
  'index=0',
  'for dir in "$@"; do',
  `  printf 'D\\0%s\\0' "$index"`,
  '  index=$((index + 1))',
  '  [ -d "$dir" ] || continue',
  // An unreadable directory must fail the whole call, matching the native
  // listEntries: silently reporting it empty would let the planner treat
  // unenumerated contents as "nothing left here" and remove the parent.
  '  if ! [ -r "$dir" ]; then',
  `    printf 'X\\0'`,
  '    continue',
  '  fi',
  '  for entry in "$dir"/* "$dir"/.*; do',
  '    name=${entry##*/}',
  '    case "$name" in "*"|".*"|"."|"..") continue ;; esac',
  '    if [ -L "$entry" ]; then kind=symlink',
  '    elif [ -d "$entry" ]; then kind=directory',
  '    elif [ -f "$entry" ]; then kind=file',
  '    elif [ -e "$entry" ]; then kind=other',
  '    else continue; fi',
  `    printf 'E\\0%s\\0%s\\0' "$name" "$kind"`,
  '  done',
  'done'
].join('\n')

export const WSL_INSPECT_PATHS_SCRIPT = [
  'set -u',
  'index=0',
  'for path in "$@"; do',
  '  if [ -L "$path" ]; then kind=symlink',
  '  elif [ -d "$path" ]; then kind=directory',
  '  elif [ -f "$path" ]; then kind=file',
  '  elif [ -e "$path" ]; then kind=other',
  '  else kind=missing; fi',
  `  resolved=$(realpath -- "$path" 2>/dev/null || printf '')`,
  // Deliberately no `-L`: WSL discovery reads mtime the same way, so the
  // freshness guard compares like with like on this host.
  `  updated=$(stat -c '%Y' -- "$path" 2>/dev/null || printf '')`,
  `  printf 'P\\0%s\\0%s\\0%s\\0%s\\0' "$index" "$kind" "$resolved" "$updated"`,
  '  index=$((index + 1))',
  'done'
].join('\n')

export class WslEnumerationProtocolError extends Error {
  constructor() {
    super('skill-install-wsl-guest-operation-failed')
    this.name = 'WslEnumerationProtocolError'
  }
}

function splitRecords(output: string): string[] {
  const fields = output.split('\0')
  // A trailing delimiter always leaves one empty field; anything else is data.
  if (fields.at(-1) === '') {
    fields.pop()
  }
  return fields
}

function isEntryKind(value: string | undefined): value is SkillFilesystemEntryKind {
  return (
    value === 'directory' ||
    value === 'file' ||
    value === 'symlink' ||
    value === 'other' ||
    value === 'missing'
  )
}

export function parseWslListEntriesOutput(
  output: string,
  directories: readonly string[]
): Map<string, SkillDirectoryEntry[]> {
  const listings = new Map<string, SkillDirectoryEntry[]>(
    directories.map((directory) => [directory, []])
  )
  const fields = splitRecords(output)
  let current: SkillDirectoryEntry[] | undefined
  let index = 0
  while (index < fields.length) {
    const record = fields[index++]
    if (record === 'D') {
      const directory = directories[Number.parseInt(fields[index++] ?? '', 10)]
      if (directory === undefined) {
        throw new WslEnumerationProtocolError()
        // `X`: the guest could not read the directory. Refusing the whole call is
        // the same contract as the native listEntries throwing on EACCES — only a
        // confirmed absence may read as an empty directory.
      }
      current = listings.get(directory)
      continue
    }
    if (record !== 'E') {
      throw new WslEnumerationProtocolError()
    }
    const name = fields[index++]
    const kind = fields[index++]
    // An `E` before any `D` would silently vanish, and a listing short of its
    // real contents reads to the planner as an empty directory it may remove.
    if (name === undefined || !isEntryKind(kind) || current === undefined) {
      throw new WslEnumerationProtocolError()
    }
    current.push({ name, kind })
  }
  return listings
}

export function parseWslInspectPathsOutput(
  output: string,
  paths: readonly string[]
): Map<string, SkillPathInspection> {
  const inspections = new Map<string, SkillPathInspection>()
  const fields = splitRecords(output)
  let index = 0
  while (index < fields.length) {
    if (fields[index++] !== 'P') {
      throw new WslEnumerationProtocolError()
    }
    const path = paths[Number.parseInt(fields[index++] ?? '', 10)]
    const kind = fields[index++]
    const resolved = fields[index++]
    const updated = Number.parseInt(fields[index++] ?? '', 10)
    if (path === undefined || !isEntryKind(kind) || resolved === undefined) {
      throw new WslEnumerationProtocolError()
    }
    inspections.set(path, {
      kind,
      realpath: resolved === '' ? null : resolved,
      // `stat -c %Y` is whole seconds, matching how WSL discovery scales it.
      mtimeMs: Number.isFinite(updated) ? updated * 1000 : null
    })
  }
  return inspections
}
