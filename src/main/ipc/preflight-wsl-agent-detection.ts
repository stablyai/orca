import { quotePosixShell } from '../../shared/shell-argument-quoting'
import path from 'node:path'
import { buildPosixFallbackPathPrelude } from '../../shared/posix-version-manager-bin-dirs'
import { buildPosixCommandPathLookupScript } from '../../shared/posix-command-path-lookup'
import { runWslProcess } from '../wsl/wsl-runner'

const WSL_AGENT_DETECTION_TIMEOUT_MS = 10000
const WSL_AGENT_DETECTION_PREFIX = '__ORCA_AGENT_PATH__'

export type WslPreflightTarget = {
  distro?: string
}

export async function detectWslCommandsOnPath(
  wslTarget: WslPreflightTarget,
  commands: readonly string[]
): Promise<Set<string>> {
  const uniqueCommands = [...new Set(commands.filter(Boolean))]
  if (uniqueCommands.length === 0) {
    return new Set()
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
    `for cmd in ${commandList}; do`,
    lookupScript,
    'if [ -n "$resolved" ]; then',
    `printf '${WSL_AGENT_DETECTION_PREFIX}%s\\t%s\\n' "$cmd" "$resolved";`,
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
    // Timeout/nonzero results may contain partial stdout, not a complete inventory.
    if (result.timedOut || result.code !== 0) {
      return new Set()
    }
    return parseWslDetectedCommands(result.stdout)
  } catch {
    return new Set()
  }
}

function parseWslDetectedCommands(stdout: string): Set<string> {
  const found = new Set<string>()
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith(WSL_AGENT_DETECTION_PREFIX)) {
      continue
    }
    const payload = line.slice(WSL_AGENT_DETECTION_PREFIX.length)
    const separatorIndex = payload.indexOf('\t')
    if (separatorIndex <= 0) {
      continue
    }
    const command = payload.slice(0, separatorIndex)
    const resolvedPath = payload.slice(separatorIndex + 1)
    // Guest executables resolve to POSIX-absolute paths; reject Windows-style output.
    if (path.posix.isAbsolute(resolvedPath)) {
      found.add(command)
    }
  }
  return found
}
