import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { isWindowsRemoteHost, normalizeWindowsRemotePath } from './ssh-remote-platform'
import { powerShellCommand } from './ssh-remote-powershell'

// Why: non-login SSH shells (the default for `exec`) don't source
// .bashrc/.zshrc, so node installed via nvm/fnm/Homebrew isn't in PATH.
// We try common locations and fall back to a login-shell `which`.
export async function resolveRemoteNodePath(
  conn: SshConnection,
  host?: RemoteHostPlatform
): Promise<string> {
  if (host && isWindowsRemoteHost(host)) {
    return resolveRemoteWindowsNodePath(conn)
  }

  const script = [
    'command -v node 2>/dev/null',
    'command -v /usr/local/bin/node 2>/dev/null',
    'command -v /opt/homebrew/bin/node 2>/dev/null',
    // Why: nvm installs into a versioned directory. `ls -1` sorts
    // alphabetically, which misorders versions (e.g. v9 > v18). Pipe
    // through `sort -V` (version sort) so we pick the highest version.
    'ls -1 $HOME/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1',
    'command -v $HOME/.local/bin/node 2>/dev/null',
    'command -v $HOME/.fnm/aliases/default/bin/node 2>/dev/null'
  ].join(' || ')

  try {
    const result = await execCommand(conn, script)
    const nodePath = result.trim().split('\n')[0]
    if (nodePath) {
      console.log(`[ssh-relay] Found node at: ${nodePath}`)
      return nodePath
    }
  } catch {
    // Fall through to login shell attempt
  }

  // Why: last resort — source the full login profile. This is separated into
  // its own exec because `bash -lc` can hang on remotes with interactive
  // shell configs (conda prompts, etc.). If this times out, the error message
  // from execCommand will tell us it was the login shell attempt.
  try {
    console.log('[ssh-relay] Trying login shell to find node...')
    const result = await execCommand(conn, "bash -lc 'command -v node' 2>/dev/null")
    const nodePath = result.trim().split('\n')[0]
    if (nodePath) {
      console.log(`[ssh-relay] Found node via login shell: ${nodePath}`)
      return nodePath
    }
  } catch {
    // Fall through
  }

  throwNodeNotFound()
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
