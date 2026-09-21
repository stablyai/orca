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

  const commandList = uniqueCommands.map(shellQuote).join(' ')
  const lookupScript = buildPosixCommandPathLookupScript(
    { kind: 'shell-variable', name: 'cmd' },
    // Skip Windows mounts DURING the walk, not after it: WSL appends the
    // Windows PATH, so a Windows `claude` can shadow a real guest install, and
    // discarding the result afterwards reports "not installed" for a user who
    // has both -- the #9725 population the fallback dirs exist to serve.
    { skipWindowsMountDirs: true }
  )
  // Newlines keep the loop valid in every POSIX shell used here.
  const script = [
    // The same fallback the preflight command runner uses: append the
    // version-manager dirs to PATH and let the ordinary lookup find them. A
    // second bespoke `[ -x ]` walk here duplicated the lookup script's own
    // `! -d` guard, which is how a directory once read as an installed CLI.
    buildPosixFallbackPathPrelude(),
    `for cmd in ${commandList}; do`,
    lookupScript,
    'if [ -n "$resolved" ]; then',
    `printf '${WSL_AGENT_DETECTION_PREFIX}%s\\t%s\\n' "$cmd" "$resolved";`,
    'fi',
    'done'
  ].join('\n')

  try {
    // Why probe: the cached login PATH gives the user's real nvm/mise/asdf PATH
    // with no shell in the loop, so there is no rc/motd banner to land in stdout.
    const result = await runWslProcess({
      distro: wslTarget.distro,
      loginPath: 'preferred',
      script,
      // POSIX `command -v` loop; declared because the payload is opaque here.
      shell: 'sh',
      timeoutMs: WSL_AGENT_DETECTION_TIMEOUT_MS
    })
    // runProcess resolves on a timeout and on a non-zero exit, so partial
    // stdout would otherwise read as a complete answer.
    if (result.timedOut || result.code !== 0) {
      return new Set()
    }
    return parseWslDetectedCommands(result.stdout)
  } catch {
    return new Set()
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
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
    // Why: a real guest executable always resolves to a POSIX-absolute path, so
    // a Windows-style C:\ path here is spoofed/non-guest output, not an install.
    if (path.posix.isAbsolute(resolvedPath)) {
      found.add(command)
    }
  }
  return found
}
