import type { SshConnection } from './ssh-connection'
import { createSshOperationAbortError } from './ssh-connection-utils'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { isWindowsRemoteHost, normalizeWindowsRemotePath } from './ssh-remote-platform'
import { powerShellCommand } from './ssh-remote-powershell'
import {
  buildPosixNodeInstallGuidance,
  type RemoteNodeResolutionOptions
} from './ssh-remote-node-install-guidance'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isSshCommandExitError } from './ssh-relay-exec-command'
import {
  buildPosixNodeToolchainProbe,
  buildWindowsNodeToolchainProbe,
  nodeToolchainVersionsMeetRequirements
} from './ssh-remote-node-toolchain-probe'
import { isSshSessionLimitError } from './ssh-session-limit-error'
import { buildSshLoginShellCommand } from './ssh-login-shell-command'
import { REMOTE_NODE_PATH_PROBE_SCRIPT } from './ssh-remote-node-probe-script'

// Why: the login-shell fallback catches custom PATH setups in ~/.profile that
// the path probes don't cover. Interactive configs (conda prompts, etc.) can
// hang a login shell, so keep this short.
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

  // Strategy 1: probe well-known install directories for every common Node
  // version manager (nvm, fnm, mise, asdf, volta, n) plus system locations.
  // This doesn't depend on shell startup-file semantics — bash -lc skips
  // .bashrc and zsh -lc skips .zshrc, but those are exactly the files where
  // nvm/mise/asdf hooks live. Probing directories directly is deterministic.
  // Why memoized: the login shell often names the Node the path probe already rejected.
  const npmCheck = memoizeCandidateCheck<true>(
    async (candidate) => (await nodeToolchainMeetsRequirements(conn, candidate, options)) || null
  )
  const probed = await tryResolveViaKnownPaths(conn, npmCheck, options)
  if (probed) {
    return probed.nodePath
  }

  // Strategy 2 (fallback): ask the user's login shell. Catches custom PATH
  // setups in ~/.profile / ~/.bash_profile that the probes don't cover.
  const loginShell = await tryResolveViaLoginShell(conn, npmCheck, options)
  if (loginShell) {
    return loginShell.nodePath
  }

  return throwNodeNotFound(conn, options)
}

export type CandidateCheck<T> = (candidate: string) => Promise<T | null>

/** Probes each candidate path once per resolution, however many strategies name it. */
export function memoizeCandidateCheck<T>(check: CandidateCheck<T>): CandidateCheck<T> {
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

/**
 * Rethrows what is not a host-answered miss: an opted-in session limit, an abort, or (under
 * `strict`) an exec that never exited. Only a command that ran and exited answered.
 */
function rethrowUnlessAnsweredMiss(err: unknown, options?: ProbeOptions): void {
  if (options?.rethrowSessionLimitErrors && isSshSessionLimitError(err)) {
    throw err
  }
  throwIfAborted(options)
  if (options?.strict && !isSshCommandExitError(err)) {
    throw err
  }
}

// Probe the on-disk install directories of every common Node version manager
// plus system package-manager locations. Every probe runs unconditionally so
// a missing directory prints nothing rather than short-circuiting later
// probes. Returns the first candidate with a complete Node/npm toolchain.
export async function tryResolveViaKnownPaths<T>(
  conn: SshConnection,
  check: CandidateCheck<T>,
  options?: ProbeOptions
): Promise<ResolvedCandidate<T> | null> {
  const script = REMOTE_NODE_PATH_PROBE_SCRIPT

  try {
    const result = await execCommandWithOptionalOptions(conn, script, signalOnlyOptions(options))
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
    // Why: the probe script always exits 0, so any failure here is an unanswered probe.
    if (options?.strict) {
      throw err
    }
    // Fall through to login shell.
  }
  return null
}

// Run `command -v node` under the user's login shell, then verify the result
// meets the minimum version. Returns null on any failure (shell missing, no
// node found, version too old, timeout) so callers fall through to the error.
export async function tryResolveViaLoginShell<T>(
  conn: SshConnection,
  check: CandidateCheck<T>,
  options?: ProbeOptions
): Promise<ResolvedCandidate<T> | null> {
  try {
    // Why: $SHELL is the user's configured login shell (set by chsh / passwd).
    // Using it — rather than hardcoding bash — means zsh/fish users whose
    // custom PATH hooks live in profile files get coverage too. We fall back
    // to sh if $SHELL is unset (rare, e.g. restricted accounts).
    const shellResult = await execCommand(
      conn,
      'echo "${SHELL:-/bin/sh}"',
      commandOptions({ timeoutMs: LOGIN_SHELL_PROBE_TIMEOUT_MS }, options)
    )
    const shell = shellResult.trim().split('\n')[0]
    if (!shell) {
      return null
    }

    const probe = buildSshLoginShellCommand(shell, 'command -v node')
    const nodePath = await execCommand(
      conn,
      probe.command,
      commandOptions({ wrapCommand: false, timeoutMs: LOGIN_SHELL_PROBE_TIMEOUT_MS }, options)
    )
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
    // Why: `command -v node` exits non-zero when the shell answered "none".
    rethrowUnlessAnsweredMiss(err, options)
    // Fall through.
  }
  return null
}

// Validates the same PATH-prepend + bare npm contract used during deployment.
// This rejects missing npm (#8450) without requiring colocation (#9165).
async function nodeToolchainMeetsRequirements(
  conn: SshConnection,
  nodePath: string,
  options?: ProbeOptions
): Promise<boolean> {
  try {
    const versionOutput = await execCommand(
      conn,
      buildPosixNodeToolchainProbe(nodePath),
      // Why: the paired probe uses POSIX PATH assignment syntax, which fish
      // and csh cannot parse when sshd delegates directly to the login shell.
      commandOptions({ wrapCommand: true }, options)
    )
    return nodeToolchainVersionsMeetRequirements(versionOutput)
  } catch (err) {
    rethrowUnlessAnsweredMiss(err, options)
    // Binary missing or fails to run — not usable.
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
    const result = await execCommand(
      conn,
      powerShellCommand(script),
      commandOptions({ wrapCommand: false }, options)
    )
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
    // Why: the script exits 1 when it finds nothing, so only an unanswered probe is unknown.
    rethrowUnlessAnsweredMiss(err, options)
    // Fall through to the shared error below.
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
      commandOptions({ wrapCommand: false }, options)
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
  // Why: strategy fallbacks intentionally swallow probe failures, but a shared
  // bootstrap abort must stay an AbortError so callers can continue fallback.
  if (options?.signal?.aborted) {
    throw createSshOperationAbortError()
  }
}

function signalOnlyOptions(
  options?: RemoteNodeResolutionOptions
): { signal: AbortSignal } | undefined {
  return options?.signal ? { signal: options.signal } : undefined
}

type RemoteExecOptions = {
  wrapCommand?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

export function commandOptions(
  base: RemoteExecOptions,
  options?: RemoteNodeResolutionOptions
): RemoteExecOptions {
  return options?.signal ? { ...base, signal: options.signal } : base
}

async function execCommandWithOptionalOptions(
  conn: SshConnection,
  command: string,
  options?: { signal: AbortSignal }
): Promise<string> {
  return options ? execCommand(conn, command, options) : execCommand(conn, command)
}
