import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { isWindowsRemoteHost, normalizeWindowsRemotePath } from './ssh-remote-platform'
import { powerShellCommand } from './ssh-remote-powershell'
import { execCommand } from './ssh-relay-deploy-helpers'

// Why: the relay requires Node.js 18+. Version managers like nvm keep every
// installed version on disk, so a naive "highest version" glob can hand back
// Node 8/10/12 and crash the relay on launch. Gate every candidate on this.
const MIN_NODE_MAJOR = 18

// Why: version-manager shells are the reliable discovery path — nvm/mise/asdf
// hook into shell init files and only expose node via PATH after sourcing.
// A login shell under the user's $SHELL sources the right init files for their
// configuration, which is where these managers put their activation hooks.
// Give it a short timeout: interactive configs (conda prompts, etc.) can hang
// a login shell, and we don't want one slow shell config to block the whole
// resolution.
const LOGIN_SHELL_PROBE_TIMEOUT_MS = 8_000

export async function resolveRemoteNodePath(
  conn: SshConnection,
  host?: RemoteHostPlatform
): Promise<string> {
  if (host && isWindowsRemoteHost(host)) {
    return resolveRemoteWindowsNodePath(conn)
  }

  // Strategy 1: ask the user's own login shell where node is. This is the only
  // path that runs version-manager init hooks (nvm.sh, `mise activate`,
  // `asdf.sh`), so it finds node even when the manager puts nothing on PATH
  // directly. We deliberately bypass wrapRemoteCommandForPosixShell here so
  // the user's shell — not /bin/sh — parses the command and sources its own
  // init files.
  const loginShellPath = await tryResolveViaLoginShell(conn)
  if (loginShellPath) {
    return loginShellPath
  }

  // Strategy 2: probe well-known version-manager install directories directly.
  // Covers users whose login shell hangs/times out, whose shell init is
  // misconfigured, or whose $SHELL doesn't match the manager they use.
  const probedPath = await tryResolveViaKnownPaths(conn)
  if (probedPath) {
    return probedPath
  }

  throwNodeNotFound()
}

// Run `command -v node` under the user's login shell, then verify the result
// meets the minimum version. Returns null on any failure (shell missing, no
// node found, version too old, timeout) so callers fall through to path probes.
async function tryResolveViaLoginShell(conn: SshConnection): Promise<string | null> {
  try {
    // Why: $SHELL is the user's configured login shell (set by chsh / passwd).
    // Using it — rather than hardcoding bash — means zsh users whose nvm/mise
    // hooks live in ~/.zshrc get found too. We fall back to sh if $SHELL is
    // unset (rare, e.g. restricted accounts).
    const shellResult = await execCommand(conn, 'echo "${SHELL:-/bin/sh}"', {
      timeoutMs: LOGIN_SHELL_PROBE_TIMEOUT_MS
    })
    const shell = shellResult.trim().split('\n')[0]
    if (!shell) {
      return null
    }

    const nodePath = await execCommand(conn, `${shellEscape(shell)} -lc 'command -v node'`, {
      wrapCommand: false,
      timeoutMs: LOGIN_SHELL_PROBE_TIMEOUT_MS
    })
    const candidate = nodePath.trim().split('\n')[0]
    if (!candidate) {
      return null
    }

    if (await nodeMeetsVersionRequirement(conn, candidate)) {
      console.log(`[ssh-relay] Found node via login shell (${shell}): ${candidate}`)
      return candidate
    }
  } catch {
    // Fall through to path probes.
  }
  return null
}

// Probe the on-disk install directories of every common Node version manager
// plus system package-manager locations. Returns the first candidate that
// both exists and meets the minimum version.
async function tryResolveViaKnownPaths(conn: SshConnection): Promise<string | null> {
  const script = [
    // System / package-manager installs.
    'command -v node 2>/dev/null',
    'command -v /usr/local/bin/node 2>/dev/null',
    'command -v /opt/homebrew/bin/node 2>/dev/null',
    'command -v $HOME/.local/bin/node 2>/dev/null',
    // nvm: respect $NVM_DIR (common dotfiles override it); fall back to the
    // default ~/.nvm. `ls -1` sorts alphabetically, which misorders versions
    // (v9 > v18); pipe through `sort -V` so we pick the highest version.
    'ls -1 ${NVM_DIR:-$HOME/.nvm}/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1',
    // fnm: default alias symlink, then versioned dirs as a fallback.
    'command -v $HOME/.fnm/aliases/default/bin/node 2>/dev/null',
    'ls -1 $HOME/.fnm/node-versions/*/installation/bin/node 2>/dev/null | sort -V | tail -1',
    // mise (formerly rtx): shims dir, then versioned installs.
    'command -v $HOME/.local/share/mise/shims/node 2>/dev/null',
    'ls -1 $HOME/.local/share/mise/installs/node/*/bin/node 2>/dev/null | sort -V | tail -1',
    // asdf: shims dir, then versioned installs.
    'command -v $HOME/.asdf/shims/node 2>/dev/null',
    'ls -1 $HOME/.asdf/installs/nodejs/*/bin/node 2>/dev/null | sort -V | tail -1',
    // volta: single bin dir with the active version symlinked in.
    'command -v $HOME/.volta/bin/node 2>/dev/null',
    // n: installs into /usr/local or a user-local prefix.
    'command -v /usr/local/n/versions/node/*/bin/node 2>/dev/null'
  ].join(' || ')

  try {
    const result = await execCommand(conn, script)
    const candidates = result
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)

    // Why: the `||` chain exits 0 as soon as one clause prints a path, so the
    // first line is our candidate. But if the shell emits multiple lines (some
    // managers leave stale shims), validate each in order and keep the first
    // that meets the version gate.
    for (const candidate of candidates) {
      if (await nodeMeetsVersionRequirement(conn, candidate)) {
        console.log(`[ssh-relay] Found node via path probe: ${candidate}`)
        return candidate
      }
    }
  } catch {
    // All probes failed.
  }
  return null
}

// Returns true if `nodePath` runs and reports Node >= MIN_NODE_MAJOR.
// Caches nothing — this runs at most twice per resolution (login shell + first
// path-probe candidate), and the exec round-trip dominates.
async function nodeMeetsVersionRequirement(
  conn: SshConnection,
  nodePath: string
): Promise<boolean> {
  try {
    const versionOutput = await execCommand(conn, `${shellEscape(nodePath)} --version`, {
      wrapCommand: false
    })
    const match = versionOutput.trim().match(/^v?(\d+)/)
    if (!match) {
      return false
    }
    const major = Number.parseInt(match[1]!, 10)
    return major >= MIN_NODE_MAJOR
  } catch {
    // Binary missing or fails to run — not usable.
    return false
  }
}

async function resolveRemoteWindowsNodePath(conn: SshConnection): Promise<string> {
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
    const result = await execCommand(conn, powerShellCommand(script), { wrapCommand: false })
    const nodePath = result.trim().split('\n')[0]
    if (nodePath) {
      const normalized = normalizeWindowsRemotePath(nodePath)
      console.log(`[ssh-relay] Found Windows node at: ${normalized}`)
      return normalized
    }
  } catch {
    // Fall through to the shared error below.
  }

  throwNodeNotFound()
}

function throwNodeNotFound(): never {
  throw new Error(
    'Node.js not found on remote host. Orca relay requires Node.js 18+. ' +
      'Install Node.js on the remote and try again.'
  )
}
