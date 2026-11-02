import {
  ORCAD_NODE_RUNTIME_DIR_PREFIX,
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  ORCAD_RUNTIMES_DIRNAME
} from '../../../shared/orcad-artifacts'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { RELAY_REMOTE_DIR } from '../../ssh/remote-exec/remote-frame-protocol'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

/** Empty per-version reference files protect runtimes from GC. */
export const RUNTIME_REF_NODE_PREFIX = '.runtime-ref-node-'
export const RUNTIME_STORE_TOMBSTONE_PREFIX = '.gc-tombstone-'
export const INVENTORY_OK = '__ORCA_RUNTIME_STORE__OK'
export const REFS_ERR = '__ORCA_RUNTIME_STORE__REFS_ERR'
export const MAX_DIRS = 512
const SHA256 = /^[0-9a-f]{64}$/
export const RUNTIME_STORE_ENTRY_NAME = new RegExp(
  `^${ORCAD_NODE_RUNTIME_DIR_PREFIX}([0-9a-f]{64})$`
)
export const RUNTIME_STORE_TOMBSTONE_NAME = new RegExp(
  `^${RUNTIME_STORE_TOMBSTONE_PREFIX.replace(/\./g, '\\.')}${ORCAD_NODE_RUNTIME_DIR_PREFIX}([0-9a-f]{64})\\.[0-9]+\\.([0-9]+)$`
)
// Windows process paths use backslashes.
const HELD_PATH = new RegExp(
  `[/\\\\]${ORCAD_RUNTIMES_DIRNAME}[/\\\\](?:${RUNTIME_STORE_TOMBSTONE_PREFIX.replace(/\./g, '\\.')})?${ORCAD_NODE_RUNTIME_DIR_PREFIX}([0-9a-f]{64})[./\\\\]`,
  'i'
)

export type RuntimeStoreInventory = {
  entries: string[]
  verifiedNewestFirst: string[]
  referenced: Set<string>
  held: Set<string>
  /** False process evidence cannot establish idleness. */
  processCheckRan: boolean
  dirNames: string[]
}

export function runtimeStoreInventoryCommand(host: RemoteHostPlatform, remoteHome: string): string {
  const root = joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR)

  const refPrefix = RUNTIME_REF_NODE_PREFIX
  return [
    `root=${quotePosixShell(root)}`,
    `rt="$root"/${ORCAD_RUNTIMES_DIRNAME}`,
    `[ -d "$rt" ] || { printf '%s\\n' ${INVENTORY_OK}; exit 0; }`,
    `[ -r "$root" ] && [ -x "$root" ] || { printf '%s\\n' ${REFS_ERR}; exit 0; }`,
    'n=0',
    // Newer clients' unrecognized install directories may still reference runtimes.
    'for d in "$root"/* "$root"/.[!.]*; do',
    '  [ -d "$d" ] || continue',
    '  name=${d##*/}',
    `  [ "$name" = ${ORCAD_RUNTIMES_DIRNAME} ] && continue`,
    `  [ -r "$d" ] && [ -x "$d" ] || { printf '%s\\n' ${REFS_ERR}; exit 0; }`,
    '  n=$((n+1))',
    `  [ "$n" -le ${MAX_DIRS} ] || { printf '%s\\n' ${REFS_ERR}; exit 0; }`,
    `  printf 'DIR %s\\n' "$name"`,
    `  if [ -e "$d"/${ORCAD_NODE_RUNTIME_MARKER_FILENAME} ]; then`,
    `    sha=$(cat "$d"/${ORCAD_NODE_RUNTIME_MARKER_FILENAME}) || { printf '%s\\n' ${REFS_ERR}; exit 0; }`,
    `    printf 'REF %s\\n' "$sha"`,
    '  fi',
    `  for f in "$d"/${refPrefix}*; do`,
    '    [ -e "$f" ] || continue',
    `    printf 'REF %s\\n' "\${f##*/${refPrefix}}"`,
    '  done',
    'done',
    `for e in "$rt"/${ORCAD_NODE_RUNTIME_DIR_PREFIX}* "$rt"/${RUNTIME_STORE_TOMBSTONE_PREFIX}${ORCAD_NODE_RUNTIME_DIR_PREFIX}*; do`,
    `  [ -d "$e" ] && printf 'ENTRY %s\\n' "\${e##*/}"`,
    'done',
    `set -- "$rt"/${ORCAD_NODE_RUNTIME_DIR_PREFIX}*/.verified`,
    'if [ -e "$1" ]; then',
    `  order=$(ls -1t -- "$@") || { printf '%s\\n' ${REFS_ERR}; exit 0; }`,
    `  printf '%s\\n' "$order" | while IFS= read -r v; do v=\${v%/.verified}; printf 'VERIFIED %s\\n' "\${v##*/}"; done`,
    'fi',
    // Processes only add holds; match runtime-relative paths to allow alternate symlinked-home spellings.
    'if ps_out=$(ps -e -o args= 2>/dev/null); then',
    "  printf 'PROCESS_CHECK ps\\n'",
    `  printf '%s\\n' "$ps_out" | grep -F -- /${ORCAD_RUNTIMES_DIRNAME}/ | sed 's/^/HOLD /'`,
    'fi',
    'if [ -n "$(readlink /proc/self/exe 2>/dev/null)" ]; then',
    "  printf 'PROCESS_CHECK proc\\n'",
    '  for p in /proc/[0-9]*/exe; do',
    '    t=$(readlink "$p" 2>/dev/null) || continue',
    `    case "$t" in */${ORCAD_RUNTIMES_DIRNAME}/*) printf 'HOLD %s\\n' "$t";; esac`,
    '  done',
    'fi',
    `printf '%s\\n' ${INVENTORY_OK}`
  ].join('\n')
}

/** Incomplete inventories keep every runtime. */
export function parseRuntimeStoreInventory(output: string): RuntimeStoreInventory | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim())
  if (!lines.includes(INVENTORY_OK) || lines.includes(REFS_ERR)) {
    return null
  }
  const inventory: RuntimeStoreInventory = {
    entries: [],
    verifiedNewestFirst: [],
    referenced: new Set(),
    held: new Set(),
    processCheckRan: false,
    dirNames: []
  }
  for (const line of lines) {
    const space = line.indexOf(' ')
    const tag = space === -1 ? line : line.slice(0, space)
    const value = space === -1 ? '' : line.slice(space + 1).trim()
    if (tag === 'REF') {
      // Invalid references could protect any runtime; stop collection.
      if (!SHA256.test(value)) {
        return null
      }
      inventory.referenced.add(value)
    } else if (
      tag === 'ENTRY' &&
      (RUNTIME_STORE_ENTRY_NAME.test(value) || RUNTIME_STORE_TOMBSTONE_NAME.test(value))
    ) {
      inventory.entries.push(value)
    } else if (tag === 'VERIFIED' && RUNTIME_STORE_ENTRY_NAME.test(value)) {
      inventory.verifiedNewestFirst.push(value)
    } else if (tag === 'HOLD') {
      const sha = HELD_PATH.exec(value)?.[1]?.toLowerCase()
      if (sha) {
        inventory.held.add(sha)
      }
    } else if (tag === 'PROCESS_CHECK') {
      inventory.processCheckRan = true
    } else if (tag === 'DIR' && value) {
      inventory.dirNames.push(value)
    }
  }
  return inventory
}
