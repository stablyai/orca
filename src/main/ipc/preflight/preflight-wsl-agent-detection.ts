import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import path from 'node:path'
import type { AgentPathMatch } from '../command-path/command-path-batch'
import { buildPosixFallbackPathPrelude } from '../../../shared/shell/command-resolution/posix-version-manager-bin-dirs'
import {
  buildPosixCommandPathLookupScript,
  POSIX_WINDOWS_MOUNT_PRELUDE
} from '../../../shared/shell/command-resolution/posix-command-path-lookup'
import { runWslProcess, type WslSpec } from '../../wsl/execution/wsl-runner'
import { getWslGuestEnvironmentGeneration } from '../../wsl/execution/wsl-guest-environment'
import {
  abortSignalReason,
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../../shared/concurrency/abort-signal-reason'
import { PromiseSettlementWaiters } from '../../../shared/concurrency/promise-settlement-waiters'

const WSL_AGENT_DETECTION_TIMEOUT_MS = 10000
const WSL_AGENT_DETECTION_PREFIX = '__ORCA_AGENT_PATH__'
const wslAgentRechecks = new Map<
  string,
  { controller: AbortController; waiters: PromiseSettlementWaiters<string | undefined> }
>()

export type WslPreflightTarget = {
  distro?: string
}

const WSL_AGENT_REALPATH = [
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
  ')'
].join('\n')

const WSL_AGENT_PATH_RECHECK = [
  WSL_AGENT_REALPATH,
  POSIX_WINDOWS_MOUNT_PRELUDE,
  'canonical=$(orca_guest_agent_path "$1") || exit 1',
  'for mount in $_orca_win_mounts; do case "${canonical%.}/" in "$mount"/*) exit 1 ;; esac; done',
  'printf "%s" "$canonical"'
].join('\n')

export function recheckWslAgentPath(
  distro: string,
  candidate: string,
  signal: AbortSignal
): Promise<string | undefined> {
  throwIfSignalAborted(signal)
  const key = JSON.stringify([
    getWslGuestEnvironmentGeneration(distro),
    distro.toLowerCase(),
    candidate
  ])
  let recheck = wslAgentRechecks.get(key)
  if (!recheck) {
    const controller = new AbortController()
    const waiters = new PromiseSettlementWaiters(
      probeWslAgentPath(distro, candidate, controller.signal),
      () => {
        if (wslAgentRechecks.get(key)?.controller === controller) {
          wslAgentRechecks.delete(key)
        }
      }
    )
    recheck = { controller, waiters }
    wslAgentRechecks.set(key, recheck)
  }
  const { controller, waiters } = recheck
  return waiters.wait({
    signal,
    deferSettled: true,
    createAbortError: () => abortSignalReason(signal),
    onAbandon: () => {
      if (waiters.waiterCount === 0 && wslAgentRechecks.get(key)?.controller === controller) {
        wslAgentRechecks.delete(key)
        controller.abort()
      }
    }
  })
}

async function probeWslAgentPath(
  distro: string,
  candidate: string,
  signal: AbortSignal
): Promise<string | undefined> {
  const result = await runWslAgentProbe({
    distro,
    loginPath: 'none',
    script: WSL_AGENT_PATH_RECHECK,
    args: [candidate],
    signal
  })
  return result?.stdout.endsWith('.') && path.posix.isAbsolute(result.stdout)
    ? result.stdout.slice(0, -1)
    : undefined
}

export async function probeWslCommandsOnPath(
  wslTarget: WslPreflightTarget,
  commands: readonly string[],
  signal?: AbortSignal
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
    WSL_AGENT_REALPATH,
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

  // Use cached login PATH without shell startup banners.
  const result = await runWslAgentProbe({
    distro: wslTarget.distro,
    loginPath: 'preferred',
    script,
    shell: 'sh',
    signal
  })
  return result
    ? {
        ...parseWslDetectedCommands(result.stdout),
        environmentResolved: result.environmentResolved
      }
    : null
}

async function runWslAgentProbe(spec: WslSpec) {
  try {
    const result = await waitForPromiseWithSignal(
      runWslProcess({ ...spec, timeoutMs: WSL_AGENT_DETECTION_TIMEOUT_MS }),
      spec.signal
    )
    return result.timedOut || result.code !== 0 || result.outputTruncated ? null : result
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
