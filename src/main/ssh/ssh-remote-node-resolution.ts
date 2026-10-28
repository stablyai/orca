import type { SshConnection } from './connection/ssh-connection'
import { createSshOperationAbortError } from './connection/ssh-exec-options'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { isWindowsRemoteHost, normalizeWindowsRemotePath } from './ssh-remote-platform'
import { powerShellCommand } from './ssh-remote-powershell'
import {
  buildPosixNodeInstallGuidance,
  type RemoteNodeResolutionOptions
} from './ssh-remote-node-install-guidance'
import { execCommand, isSshCommandExitError } from './remote-exec/remote-exec-command'
import {
  buildPosixNodeToolchainProbe,
  buildWindowsNodeToolchainProbe,
  nodeToolchainVersionsMeetRequirements
} from './ssh-remote-node-toolchain-probe'
import { isSshSessionLimitError } from './ssh-session-limit-error'
import { buildSshLoginShellCommand } from './ssh-login-shell-command'
import { REMOTE_NODE_PATH_PROBE_SCRIPT } from './ssh-remote-node-probe-script'

// Login fallback covers custom profiles but can hang on interactive setup; keep its deadline short.
const LOGIN_SHELL_PROBE_TIMEOUT_MS = 8_000

/** The probes answered and no usable Node.js + npm exists; only `strict` resolution proves it. */
export class RemoteNodeNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemoteNodeNotFoundError'
  }
}

/** `strict` rethrows probes the host never answered, so a not-found is proof, not a lost channel. */
export async function resolveRemoteNodePath(
  conn: SshConnection,
  host?: RemoteHostPlatform,
  options?: ProbeOptions
): Promise<string> {
  if (host && isWindowsRemoteHost(host)) {
    return resolveRemoteWindowsNodePath(conn, options)
  }

  // Probe manager/system directories independent of rc semantics; memoize across fallback because login shell often repeats rejected candidates.
  const npmCheck = memoizeCandidateCheck<true>(
    async (candidate) => (await nodeToolchainMeetsRequirements(conn, candidate, options)) || null
  )
  const probed = await tryResolveViaKnownPaths(conn, npmCheck, options)
  if (probed) {
    return probed.nodePath
  }

  const loginShell = await tryResolveViaLoginShell(conn, npmCheck, options)
  if (loginShell) {
    return loginShell.nodePath
  }

  return throwNodeNotFound(conn, options)
}

type CandidateCheck<T> = (candidate: string) => Promise<T | null>

function memoizeCandidateCheck<T>(check: CandidateCheck<T>): CandidateCheck<T> {
  const results = new Map<string, Promise<T | null>>()
  return (candidate) => {
    let result = results.get(candidate)
    if (!result) {
      result = check(candidate)
      results.set(candidate, result)
    }
    return result
  }
}
type ResolvedCandidate<T> = { nodePath: string; result: T }
/** `strict` rethrows unanswered probes rather than reading them as "no Node here". */
export type ProbeOptions = RemoteNodeResolutionOptions & { strict?: boolean }

/** Rethrow abort/session-limit as requested, and unanswered exec under strict mode; only completed host commands prove misses. */
function rethrowUnlessAnsweredMiss(err: unknown, options?: ProbeOptions): void {
  if (options?.rethrowSessionLimitErrors && isSshSessionLimitError(err)) {
    throw err
  }
  throwIfAborted(options)
  if (options?.strict && !isSshCommandExitError(err)) {
    throw err
  }
}

// Run all manager/system probes; select the first complete Node/npm toolchain without short-circuiting discovery.
async function tryResolveViaKnownPaths<T>(
  conn: SshConnection,
  check: CandidateCheck<T>,
  options?: ProbeOptions
): Promise<ResolvedCandidate<T> | null> {
  const script = REMOTE_NODE_PATH_PROBE_SCRIPT

  try {
    const result = await execCommand(conn, script, { signal: options?.signal })
    const seen = new Set<string>()
    for (const line of result.split('\n')) {
      const candidate = line.trim()
      if (!candidate || seen.has(candidate)) {
        continue
      }
      seen.add(candidate)
      const result = await check(candidate)
      if (result !== null) {
        console.log(`[ssh-relay] Found node via path probe: ${candidate}`)
        return { nodePath: candidate, result }
      }
    }
  } catch (err) {
    if (options?.rethrowSessionLimitErrors && isSshSessionLimitError(err)) {
      throw err
    }
    throwIfAborted(options)
    // This inventory script always exits 0, so a failed command is unanswered evidence.
    if (options?.strict) {
      throw err
    }
  }
  return null
}

// Probe configured login shell then validate Node; permissive callers fall through on failures, strict callers retain unanswered evidence.
export async function tryResolveViaLoginShell<T>(
  conn: SshConnection,
  check: CandidateCheck<T>,
  options?: ProbeOptions
): Promise<ResolvedCandidate<T> | null> {
  try {
    // Respect chsh/passwd SHELL for custom profiles; restricted accounts without it use sh.
    const shellResult = await execCommand(conn, 'echo "${SHELL:-/bin/sh}"', {
      timeoutMs: LOGIN_SHELL_PROBE_TIMEOUT_MS,
      signal: options?.signal
    })
    const shell = shellResult.trim().split('\n')[0]
    if (!shell) {
      return null
    }

    const probe = buildSshLoginShellCommand(shell, 'command -v node')
    const nodePath = await execCommand(conn, probe.command, {
      wrapCommand: false,
      timeoutMs: LOGIN_SHELL_PROBE_TIMEOUT_MS,
      signal: options?.signal
    })
    const candidate = probe.readStdout(nodePath)?.trim().split('\n')[0]
    if (!candidate) {
      return null
    }

    const result = await check(candidate)
    if (result !== null) {
      console.log(`[ssh-relay] Found node via login shell (${shell}): ${candidate}`)
      return { nodePath: candidate, result }
    }
  } catch (err) {
    // command -v can answer nonzero for missing Node; rethrow only unanswered failures.
    rethrowUnlessAnsweredMiss(err, options)
  }
  return null
}

// Match deploy PATH-prepend plus bare npm: require npm without requiring colocation (#8450, #9165).
async function nodeToolchainMeetsRequirements(
  conn: SshConnection,
  nodePath: string,
  options?: ProbeOptions
): Promise<boolean> {
  try {
    const versionOutput = await execCommand(
      conn,
      buildPosixNodeToolchainProbe(nodePath),
      // Wrap POSIX PATH assignment before fish/csh login shells parse it.
      { wrapCommand: true, signal: options?.signal }
    )
    return nodeToolchainVersionsMeetRequirements(versionOutput)
  } catch (err) {
    rethrowUnlessAnsweredMiss(err, options)
    return false
  }
}

async function resolveRemoteWindowsNodePath(
  conn: SshConnection,
  options?: ProbeOptions
): Promise<string> {
  const script = [
    '$paths = @()',
    '$cmd = Get-Command node.exe -ErrorAction SilentlyContinue',
    'if ($cmd -and $cmd.Source) { $paths += $cmd.Source }',
    'if ($env:ProgramFiles) { $paths += (Join-Path $env:ProgramFiles "nodejs/node.exe") }',
    'if (${env:ProgramFiles(x86)}) { $paths += (Join-Path ${env:ProgramFiles(x86)} "nodejs/node.exe") }',
    'if ($env:LOCALAPPDATA) { $paths += (Join-Path $env:LOCALAPPDATA "Programs/nodejs/node.exe") }',
    '$found = $false',
    'foreach ($path in $paths) {',
    '  if ($path -and (Test-Path -LiteralPath $path -PathType Leaf)) {',
    '    Write-Output $path',
    '    $found = $true',
    '  }',
    '}',
    'if ($found) { exit 0 }',
    "Write-Error 'Node.js not found'",
    'exit 1'
  ].join('\n')

  try {
    const result = await execCommand(conn, powerShellCommand(script), {
      wrapCommand: false,
      signal: options?.signal
    })
    for (const line of result.split('\n')) {
      const nodePath = line.trim()
      if (!nodePath) {
        continue
      }
      const normalized = normalizeWindowsRemotePath(nodePath)
      if (await windowsNodeToolchainMeetsRequirements(conn, normalized, options)) {
        console.log(`[ssh-relay] Found Windows node at: ${normalized}`)
        return normalized
      }
    }
  } catch (err) {
    // The Windows probe exits 1 on an answered miss; only unanswered execution stays unknown.
    rethrowUnlessAnsweredMiss(err, options)
  }

  throwWindowsNodeNotFound(options)
}

async function windowsNodeToolchainMeetsRequirements(
  conn: SshConnection,
  nodePath: string,
  options?: ProbeOptions
): Promise<boolean> {
  try {
    const versionOutput = await execCommand(
      conn,
      powerShellCommand(buildWindowsNodeToolchainProbe(nodePath)),
      { wrapCommand: false, signal: options?.signal }
    )
    return nodeToolchainVersionsMeetRequirements(versionOutput)
  } catch (err) {
    rethrowUnlessAnsweredMiss(err, options)
    return false
  }
}

async function throwNodeNotFound(
  conn: SshConnection,
  options?: RemoteNodeResolutionOptions
): Promise<never> {
  throwIfAborted(options)
  const guidance = await buildPosixNodeInstallGuidance(conn, options)
  throwIfAborted(options)
  throw new RemoteNodeNotFoundError(guidance)
}

function throwWindowsNodeNotFound(options?: RemoteNodeResolutionOptions): never {
  throwIfAborted(options)
  throw new RemoteNodeNotFoundError(
    [
      'Node.js not found on remote host. Orca relay requires Node.js 18+ and npm.',
      '',
      'Install Node.js 18+ on the remote host, then reconnect:',
      '  winget install OpenJS.NodeJS.LTS',
      '  choco install nodejs-lts',
      '',
      'Verify the remote runtime before reconnecting:',
      '  node --version  # must be v18 or newer',
      '  npm --version',
      '',
      'If those package managers are unavailable, install an LTS release from https://nodejs.org/.'
    ].join('\n')
  )
}

export function throwIfAborted(options?: RemoteNodeResolutionOptions): void {
  // Restore shared AbortError after permissive strategy catches so bootstrap can safely fall back.
  if (options?.signal?.aborted) {
    throw createSshOperationAbortError()
  }
}
