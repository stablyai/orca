import type { SshConnection } from './ssh-connection'
import { createSshOperationAbortError, shellEscape } from './ssh-connection-utils'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { isWindowsRemoteHost, normalizeWindowsRemotePath } from './ssh-remote-platform'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'
import {
  buildPosixNodeInstallGuidance,
  type RemoteNodeResolutionOptions
} from './ssh-remote-node-install-guidance'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isSshSessionLimitError } from './ssh-session-limit-error'

// Why: the relay requires Node.js 18+. Version managers like nvm keep every
// installed version on disk, so a naive "highest version" glob can hand back
// Node 8/10/12 and crash the relay on launch. Gate every candidate on this.
const MIN_NODE_MAJOR = 18

// Why: the login-shell fallback catches custom PATH setups in ~/.profile that
// the path probes don't cover. Interactive configs (conda prompts, etc.) can
// hang a login shell, so keep this short.
const LOGIN_SHELL_PROBE_TIMEOUT_MS = 8_000

export async function resolveRemoteNodePath(
  conn: SshConnection,
  host?: RemoteHostPlatform,
  options?: RemoteNodeResolutionOptions
): Promise<string> {
  if (host && isWindowsRemoteHost(host)) {
    return resolveRemoteWindowsNodePath(conn, options)
  }

  // Strategy 1: probe well-known install directories for every common Node
  // version manager (nvm, fnm, mise, asdf, volta, n) plus system locations.
  // This doesn't depend on shell startup-file semantics — bash -lc skips
  // .bashrc and zsh -lc skips .zshrc, but those are exactly the files where
  // nvm/mise/asdf hooks live. Probing directories directly is deterministic.
  const probedPath = await tryResolveViaKnownPaths(conn, options)
  if (probedPath) {
    return probedPath
  }

  // Strategy 2 (fallback): ask the user's login shell. Catches custom PATH
  // setups in ~/.profile / ~/.bash_profile that the probes don't cover.
  const loginShellPath = await tryResolveViaLoginShell(conn, options)
  if (loginShellPath) {
    return loginShellPath
  }

  return throwNodeNotFound(conn, options)
}

// Probe the on-disk install directories of every common Node version manager
// plus system package-manager locations. Every probe runs unconditionally so
// a missing directory prints nothing rather than short-circuiting later
// probes. Returns the first candidate that meets the minimum version.
async function tryResolveViaKnownPaths(
  conn: SshConnection,
  options?: RemoteNodeResolutionOptions
): Promise<string | null> {
  const script = `
command -v node 2>/dev/null
nvm_dirs=\${NVM_DIR:-"$HOME/.nvm"}
for nvm_file in "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.zprofile" "$HOME/.zshrc"
do
  [ -r "$nvm_file" ] || continue
  nvm_dir_from_file=$(sed -n 's/^[[:space:]]*export[[:space:]][[:space:]]*NVM_DIR[[:space:]]*=[[:space:]]*//p; s/^[[:space:]]*NVM_DIR[[:space:]]*=[[:space:]]*//p' "$nvm_file" | tail -n 1)
  case "$nvm_dir_from_file" in
    \\"*\\") nvm_dir_from_file=\${nvm_dir_from_file#\\"}; nvm_dir_from_file=\${nvm_dir_from_file%%\\"*} ;;
    \\'*\\') nvm_dir_from_file=\${nvm_dir_from_file#\\'}; nvm_dir_from_file=\${nvm_dir_from_file%%\\'*} ;;
    *) nvm_dir_from_file=\${nvm_dir_from_file%%[[:space:]]*} ;;
  esac
  case "$nvm_dir_from_file" in
    '$HOME'*) nvm_dir_from_file="$HOME\${nvm_dir_from_file#'$HOME'}" ;;
    "~/"*) nvm_dir_from_file="$HOME/\${nvm_dir_from_file#\\~/}" ;;
  esac
  [ -n "$nvm_dir_from_file" ] && nvm_dirs="$nvm_dirs
$nvm_dir_from_file"
done
printf '%s\\n' "$nvm_dirs" | while IFS= read -r nvm_dir
do
  [ -n "$nvm_dir" ] || continue
  for candidate in "$nvm_dir"/versions/node/*/bin/node
  do
    [ -x "$candidate" ] && printf '%s\\n' "$candidate"
  done
done
for candidate in \\
  /usr/local/bin/node \\
  /opt/homebrew/bin/node \\
  "$HOME/.local/bin/node" \\
  "$HOME/.fnm/aliases/default/bin/node" \\
  "$HOME/.fnm/node-versions"/*/installation/bin/node \\
  "$HOME/.local/share/fnm/node-versions"/*/installation/bin/node \\
  "$HOME/.local/share/mise/shims/node" \\
  "$HOME/.local/share/mise/installs/node"/*/bin/node \\
  "$HOME/.asdf/shims/node" \\
  "$HOME/.asdf/installs/nodejs"/*/bin/node \\
  "$HOME/.volta/bin/node" \\
  /usr/local/n/versions/node/*/bin/node
do
  [ -x "$candidate" ] && printf '%s\\n' "$candidate"
done
true
`

  try {
    const result = await execCommandWithOptionalOptions(conn, script, signalOnlyOptions(options))
    const seen = new Set<string>()
    for (const line of result.split('\n')) {
      const candidate = line.trim()
      if (!candidate || seen.has(candidate)) {
        continue
      }
      seen.add(candidate)
      if (await nodeMeetsVersionRequirement(conn, candidate, options)) {
        console.log(`[ssh-relay] Found node via path probe: ${candidate}`)
        return candidate
      }
    }
  } catch (err) {
    if (options?.rethrowSessionLimitErrors && isSshSessionLimitError(err)) {
      throw err
    }
    // Fall through to login shell.
  }
  return null
}

// Run `command -v node` under the user's login shell, then verify the result
// meets the minimum version. Returns null on any failure (shell missing, no
// node found, version too old, timeout) so callers fall through to the error.
async function tryResolveViaLoginShell(
  conn: SshConnection,
  options?: RemoteNodeResolutionOptions
): Promise<string | null> {
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

    const nodePath = await execCommand(
      conn,
      buildCommandInShell(shell, 'command -v node'),
      commandOptions({ wrapCommand: false, timeoutMs: LOGIN_SHELL_PROBE_TIMEOUT_MS }, options)
    )
    const candidate = nodePath.trim().split('\n')[0]
    if (!candidate) {
      return null
    }

    if (await nodeMeetsVersionRequirement(conn, candidate, options)) {
      console.log(`[ssh-relay] Found node via login shell (${shell}): ${candidate}`)
      return candidate
    }
  } catch (err) {
    if (options?.rethrowSessionLimitErrors && isSshSessionLimitError(err)) {
      throw err
    }
    // Fall through.
  }
  return null
}

function buildCommandInShell(shell: string, command: string): string {
  const shellName = shell.split('/').at(-1)
  // Why: dash and POSIX sh do not require `-l`; when $SHELL falls back to
  // /bin/sh, prefer a portable command over login-shell semantics.
  const mode = shellName === 'sh' || shellName === 'dash' ? '-c' : '-lc'
  return `${shellEscape(shell)} ${mode} ${shellEscape(command)}`
}

// Returns true if `nodePath` runs and reports Node >= MIN_NODE_MAJOR.
// Caches nothing — this runs at most a few times per resolution (one per
// candidate), and the exec round-trip dominates.
async function nodeMeetsVersionRequirement(
  conn: SshConnection,
  nodePath: string,
  options?: RemoteNodeResolutionOptions
): Promise<boolean> {
  try {
    const versionOutput = await execCommand(
      conn,
      `${shellEscape(nodePath)} --version`,
      commandOptions({ wrapCommand: false }, options)
    )
    return nodeVersionMeetsRequirement(versionOutput)
  } catch (err) {
    if (options?.rethrowSessionLimitErrors && isSshSessionLimitError(err)) {
      throw err
    }
    // Binary missing or fails to run — not usable.
    return false
  }
}

async function resolveRemoteWindowsNodePath(
  conn: SshConnection,
  options?: RemoteNodeResolutionOptions
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
      if (await windowsNodeMeetsVersionRequirement(conn, normalized, options)) {
        console.log(`[ssh-relay] Found Windows node at: ${normalized}`)
        return normalized
      }
    }
  } catch (err) {
    if (options?.rethrowSessionLimitErrors && isSshSessionLimitError(err)) {
      throw err
    }
    // Fall through to the shared error below.
  }

  throwWindowsNodeNotFound(options)
}

async function windowsNodeMeetsVersionRequirement(
  conn: SshConnection,
  nodePath: string,
  options?: RemoteNodeResolutionOptions
): Promise<boolean> {
  try {
    const versionOutput = await execCommand(
      conn,
      powerShellCommand(`& ${powerShellLiteral(nodePath)} --version`),
      commandOptions({ wrapCommand: false }, options)
    )
    return nodeVersionMeetsRequirement(versionOutput)
  } catch (err) {
    if (options?.rethrowSessionLimitErrors && isSshSessionLimitError(err)) {
      throw err
    }
    return false
  }
}

function nodeVersionMeetsRequirement(versionOutput: string): boolean {
  const match = versionOutput.trim().match(/^v?(\d+)/)
  if (!match) {
    return false
  }
  const major = Number.parseInt(match[1]!, 10)
  return major >= MIN_NODE_MAJOR
}

async function throwNodeNotFound(
  conn: SshConnection,
  options?: RemoteNodeResolutionOptions
): Promise<never> {
  throwIfAborted(options)
  const guidance = await buildPosixNodeInstallGuidance(conn, options)
  throwIfAborted(options)
  throw new Error(guidance)
}

function throwWindowsNodeNotFound(options?: RemoteNodeResolutionOptions): never {
  throwIfAborted(options)
  throw new Error(
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

function throwIfAborted(options?: RemoteNodeResolutionOptions): void {
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

function commandOptions(
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
