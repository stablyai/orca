import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import path from 'node:path'
import type { AgentPathMatch } from '../command-path/command-path-batch'
import { buildPosixFallbackPathPrelude } from '../../../shared/shell/command-resolution/posix-version-manager-bin-dirs'
import { buildPosixCommandPathLookupScript } from '../../../shared/shell/command-resolution/posix-command-path-lookup'
import { runWslProcess } from '../../wsl/execution/wsl-runner'

const WSL_AGENT_DETECTION_TIMEOUT_MS = 10000
const WSL_AGENT_DETECTION_PREFIX = '__ORCA_AGENT_PATH__'

export type WslPreflightTarget = {
  distro?: string
}

export async function probeWslCommandsOnPath(
  wslTarget: WslPreflightTarget,
  commands: readonly string[]
): Promise<{
  found: Set<string>
  matches: Map<string, AgentPathMatch>
  environmentResolved: boolean
} | null> {
  const uniqueCommands = [...new Set(commands.filter(Boolean))]
  if (uniqueCommands.length === 0) {
    return { found: new Set(), matches: new Map(), environmentResolved: true }
  }

  const commandList = uniqueCommands.map(quotePosixShell).join(' ')
  const lookupScript = buildPosixCommandPathLookupScript(
    { kind: 'shell-variable', name: 'cmd' },
    // Skip Windows mounts while walking so an interop binary cannot hide a later guest install (#9725).
    { skipWindowsMountDirs: true }
  )
  // Newlines keep the loop valid in every POSIX shell used here.
  const script = [
    // Reuse the common version-manager fallback and executable lookup, including directory rejection.
    buildPosixFallbackPathPrelude(),
    'orca_guest_agent_path() (',
    '  item=$1; links=0',
    '  while :; do',
    '    parent=${item%/*}; CDPATH= cd -P "${parent:-/}" || return 1',
    '    parent=$(pwd -P && printf .) || return 1; parent=${parent%??}',
    '    item="${parent%/}/${item##*/}"',
    '    if [ ! -L "$item" ]; then',
    '      [ -f "$item" ] && [ -x "$item" ] && printf "%s." "$item"; return "$?"',
    '    fi',
    '    [ "$links" -lt 40 ] || return 1',
    '    link=$(command -p readlink "$item" && printf .) || return 1; link=${link%??}',
    '    case "$link" in /*) item=$link ;; *) item="${parent%/}/$link" ;; esac',
    '    links=$((links + 1))',
    '  done',
    ')',
    `for cmd in ${commandList}; do`,
    lookupScript,
    'if [ -n "$resolved" ]; then',
    '  canonical=$(orca_guest_agent_path "$resolved") || canonical=;',
    '  canonical=${canonical%.};',
    '  for mount in $_orca_win_mounts; do case "$canonical/" in "$mount"/*) canonical= ;; esac; done;',
    `printf '${WSL_AGENT_DETECTION_PREFIX}%s\\t%s\\t%s\\n' "$cmd" "$resolved" "$canonical";`,
    'fi',
    'done'
  ].join('\n')

  try {
    // Use cached login PATH without shell startup banners.
    const result = await runWslProcess({
      distro: wslTarget.distro,
      loginPath: 'preferred',
      script,
      // POSIX `command -v` loop; declared because the payload is opaque here.
      shell: 'sh',
      timeoutMs: WSL_AGENT_DETECTION_TIMEOUT_MS
    })
    if (result.timedOut || result.code !== 0 || result.outputTruncated) {
      return null
    }
    return {
      ...parseWslDetectedCommands(result.stdout),
      environmentResolved: result.environmentResolved
    }
  } catch {
    return null
  }
}

function parseWslDetectedCommands(stdout: string) {
  const found = new Set<string>()
  const matches = new Map<string, AgentPathMatch>()
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(WSL_AGENT_DETECTION_PREFIX)) {
      continue
    }
    const payload = line.slice(WSL_AGENT_DETECTION_PREFIX.length)
    const [command, resolvedPath, canonicalPath] = payload.split('\t')
    if (command && resolvedPath && path.posix.isAbsolute(resolvedPath)) {
      found.add(command)
      if (canonicalPath && path.posix.isAbsolute(canonicalPath)) {
        matches.set(command, { first: resolvedPath, user: canonicalPath })
      }
    }
  }
  return { found, matches }
}
