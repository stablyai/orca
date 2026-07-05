import type { SshConnection } from './ssh-connection'
import { createSshOperationAbortError, shellEscape } from './ssh-connection-utils'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { isWindowsRemoteHost, normalizeWindowsRemotePath } from './ssh-remote-platform'
import { powerShellCommand } from './ssh-remote-powershell'
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

type RemoteNodeResolutionOptions = {
  rethrowSessionLimitErrors?: boolean
  signal?: AbortSignal
}

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

  throwNodeNotFound(options)
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
    const result = await execCommand(conn, script, { signal: options?.signal })
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
    const shellResult = await execCommand(conn, 'echo "${SHELL:-/bin/sh}"', {
      timeoutMs: LOGIN_SHELL_PROBE_TIMEOUT_MS,
      signal: options?.signal
    })
    const shell = shellResult.trim().split('\n')[0]
    if (!shell) {
      return null
    }

    const nodePath = await execCommand(conn, buildCommandInShell(shell, 'command -v node'), {
      wrapCommand: false,
      timeoutMs: LOGIN_SHELL_PROBE_TIMEOUT_MS,
      signal: options?.signal
    })
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
    const versionOutput = await execCommand(conn, `${shellEscape(nodePath)} --version`, {
      wrapCommand: false,
      signal: options?.signal
    })
    const match = versionOutput.trim().match(/^v?(\d+)/)
    if (!match) {
      return false
    }
    const major = Number.parseInt(match[1]!, 10)
    return major >= MIN_NODE_MAJOR
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
    'foreach ($path in $paths) {',
    '  if ($path -and (Test-Path -LiteralPath $path -PathType Leaf)) {',
    '    Write-Output $path',
    '    exit 0',
    '  }',
    '}',
    "Write-Error 'Node.js not found'",
    'exit 1'
  ].join('\n')

  try {
    const result = await execCommand(conn, powerShellCommand(script), {
      wrapCommand: false,
      signal: options?.signal
    })
    const nodePath = result.trim().split('\n')[0]
    if (nodePath) {
      const normalized = normalizeWindowsRemotePath(nodePath)
      console.log(`[ssh-relay] Found Windows node at: ${normalized}`)
      return normalized
    }
  } catch (err) {
    if (options?.rethrowSessionLimitErrors && isSshSessionLimitError(err)) {
      throw err
    }
    // Fall through to the shared error below.
  }

  throwNodeNotFound(options)
}

function throwNodeNotFound(options?: RemoteNodeResolutionOptions): never {
  // Why: when a sibling bootstrap probe aborts this resolution via the shared
  // signal, the strategy catch-blocks swallow the injected AbortError and fall
  // through to here. Surfacing "Node.js not found" would launder a cancellation
  // into a fatal non-session failure, defeating the concurrent-bootstrap
  // sequential fallback. Re-raise the abort so callers classify it correctly.
  if (options?.signal?.aborted) {
    throw createSshOperationAbortError()
  }
  throw new Error(
    'Node.js not found on remote host. Orca relay requires Node.js 18+. ' +
      'Install Node.js on the remote and try again.'
  )
}
