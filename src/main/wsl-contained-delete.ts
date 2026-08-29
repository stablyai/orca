import { posix } from 'node:path'
import type { WslPathInfo } from './wsl'

const REJECTION_PREFIX = 'ORCA_WSL_DELETE_REJECT:'

export type WslDeleteRejection = 'path-outside-known-roots' | 'unexpected-target-kind'

export const WSL_CONTAINED_DELETE_SCRIPT = String.raw`
reject() { printf '${REJECTION_PREFIX}%s\n' "$1" >&2; exit 65; }
missing_entry() {
  command ls -A -- . >/dev/null 2>&1 || reject inspection
  for entry in ./* ./.[!.]* ./..?*; do
    [ "$entry" = "./$1" ] && return 1
  done
  return 0
}
expected_kind=$1
root_count=$2
shift 2
cd -P -- / || reject inspection

while [ "$root_count" -gt 0 ]; do
  component=$1
  shift
  root_count=$((root_count - 1))
  inspected=$(stat -Lc '%d:%i:%F' -- "/proc/self/cwd/$component" 2>/dev/null) || {
    missing_entry "$component" && exit 0
    reject inspection
  }
  entry_kind=$(printf '%s' "$inspected" | cut -d: -f3-)
  [ "$entry_kind" = directory ] || reject inspection
  expected_id=$(printf '%s' "$inspected" | cut -d: -f1-2)
  cd -P -- "/proc/self/cwd/$component" || reject inspection
  actual_id=$(stat -Lc '%d:%i' -- . 2>/dev/null) || reject inspection
  [ "$actual_id" = "$expected_id" ] || reject race
done

root_physical=$(pwd -P) || reject inspection
[ "$root_physical" != / ] || reject containment
exec 3< . || reject inspection

while [ "$#" -gt 1 ]; do
  component=$1
  shift
  inspected=$(stat -c '%d:%i:%F' -- "/proc/self/fd/3/$component" 2>/dev/null) || {
    missing_entry "$component" && exit 0
    reject inspection
  }
  [ "$(printf '%s' "$inspected" | cut -d: -f3-)" = directory ] || reject symlink
  expected_id=$(printf '%s' "$inspected" | cut -d: -f1-2)
  cd -P -- "/proc/self/fd/3/$component" || reject inspection
  actual_id=$(stat -Lc '%d:%i' -- . 2>/dev/null) || reject inspection
  [ "$actual_id" = "$expected_id" ] || reject race
  current_physical=$(pwd -P) || reject inspection
  case "$current_physical/" in "$root_physical/"*) ;; *) reject containment ;; esac
  exec 3<&-
  exec 3< . || reject inspection
done

[ "$#" -eq 1 ] || reject containment
leaf=$1
leaf_path=/proc/self/fd/3/$leaf
inspected=$(stat -c '%d:%i:%F' -- "$leaf_path" 2>/dev/null) || {
  missing_entry "$leaf" && exit 0
  reject inspection
}
actual_kind=$(printf '%s' "$inspected" | cut -d: -f3-)
[ "$actual_kind" = "$expected_kind" ] || reject kind

if [ "$expected_kind" = directory ]; then
  rm -rf -- "$leaf_path"
else
  rm -f -- "$leaf_path"
fi
`

export function containedDeleteCommand(
  target: WslPathInfo,
  approvedRoots: readonly string[],
  parsePath: (path: string) => WslPathInfo | null,
  recursive: boolean
): string[] | null {
  const targetPath = posix.resolve(target.linuxPath)
  const matchedRoot = approvedRoots
    .map(parsePath)
    .filter((root): root is WslPathInfo => root?.distro === target.distro)
    .map((root) => posix.resolve(root.linuxPath))
    .filter((root) => isInside(root, targetPath) && root !== '/')
    .sort((left, right) => right.length - left.length)[0]
  if (!matchedRoot) {
    return null
  }

  const relativeParts = posix.relative(matchedRoot, targetPath).split('/').filter(Boolean)
  if (relativeParts.length === 0) {
    return null
  }
  const rootParts = matchedRoot.split('/').filter(Boolean)
  return [
    'sh',
    '-c',
    WSL_CONTAINED_DELETE_SCRIPT,
    'orca-wsl-delete',
    recursive ? 'directory' : 'regular file',
    String(rootParts.length),
    ...rootParts,
    ...relativeParts
  ]
}

export function rejectionFromWslDeleteStderr(stderr: string): WslDeleteRejection | null {
  const marker = stderr
    .split(/\r?\n/u)
    .find((line) => line.startsWith(REJECTION_PREFIX))
    ?.slice(REJECTION_PREFIX.length)
  if (!marker) {
    return null
  }
  return marker === 'kind' ? 'unexpected-target-kind' : 'path-outside-known-roots'
}

function isInside(root: string, target: string): boolean {
  const relative = posix.relative(root, target)
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith('../') &&
    !posix.isAbsolute(relative)
  )
}
