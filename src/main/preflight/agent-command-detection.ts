import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { detectWslCommandsOnPath } from '../ipc/preflight/preflight-wsl-agent-detection'
import { detectCommandsInInstallDirs } from '../../shared/agent-launch/installation/local-agent-install-dir-detection'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight/preflight-runtime-target'
import { findCommandsOnLocalPath } from '../ipc/command-path/command-path-resolver'
import { buildLocalPreflightEnv } from '../ipc/preflight/preflight-local-env'
import { readGuestWindowsDriveMounts } from '../wsl/filesystem/wsl-guest-windows-drive-path'
import { hasPathSeparatorToken } from '../../shared/agent-launch/installation/managed-agent-command-token'
import { isQuotedWindowsPathEntry } from '../../shared/shell/command-resolution/node-cli-command-resolution'
import {
  isOrcaAgentRuntimePath,
  withoutOrcaAgentRuntimeDirectories
} from '../managed-agent-cli/managed-agent-cli-path'

export async function detectAgentCommandsOnHost(
  commands: readonly string[],
  options: {
    connectionId?: string | null
    context?: PreflightRuntimeContext
    /** Overrides may explicitly name an executable in Orca's runtime directory. */
    overrideCommands?: ReadonlySet<string>
    /** Filled with full paths when the command needs one (installer dir or quoted Windows PATH). */
    outsidePath?: Map<string, string>
  } = {}
): Promise<Set<string>> {
  if (options.connectionId) {
    throw new SshHostNotServedError(options.connectionId)
  }
  const context = options.context
  const wslTarget = getPreflightWslTarget(context)
  if (wslTarget) {
    return detectWslCommandsOnPath(wslTarget, commands)
  }
  // Bounded directory scans avoid repeated probes for missing commands (#34636).
  const guestMounts = readGuestWindowsDriveMounts()
  const env = buildLocalPreflightEnv(guestMounts) ?? process.env
  const pathKey =
    process.platform === 'win32' && env.PATH === undefined
      ? (Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH')
      : 'PATH'
  const pathEnv = withoutOrcaAgentRuntimeDirectories(env[pathKey] ?? '')
  const userCommands = commands.filter(
    (cmd) => options.overrideCommands?.has(cmd) || !isOrcaAgentRuntimePath(cmd)
  )
  const entries = process.platform === 'win32' ? pathEnv.split(';') : []
  const quoted = entries.filter(isQuotedWindowsPathEntry)
  const onPathCommands = await findCommandsOnLocalPath(userCommands, {
    env: {
      ...env,
      [pathKey]: quoted.length
        ? entries.filter((entry) => !isQuotedWindowsPathEntry(entry)).join(';')
        : pathEnv
    },
    // The app's cwd cannot establish that a PowerShell tab can launch the command by name.
    ...(quoted.length ? { cwd: '' } : {})
  })
  // A path was already checked directly; the install-dir fallback would count any absolute path as found.
  const missedCommands = userCommands.filter(
    (cmd) => !onPathCommands.has(cmd) && !hasPathSeparatorToken(cmd)
  )
  // PowerShell needs the full path when the only hit is in a quoted Windows entry.
  if (quoted.length > 0) {
    const onQuotedPath = await findCommandsOnLocalPath(missedCommands, {
      env: { ...env, [pathKey]: quoted.join(';') },
      cwd: '',
      matches: options.outsidePath
    })
    onQuotedPath.forEach((command) => onPathCommands.add(command))
  }
  // The batch includes the fallback's PATH normalization and Windows executable names.
  const installDirCommands = await detectCommandsInInstallDirs(
    missedCommands.filter((command) => !onPathCommands.has(command)),
    pathEnv,
    { skipPathSearch: true }
  )
  for (const [command, path] of installDirCommands) {
    if (isOrcaAgentRuntimePath(path)) {
      installDirCommands.delete(command)
    }
  }
  const foundCommands = new Set(
    commands.filter((cmd) => onPathCommands.has(cmd) || installDirCommands.has(cmd))
  )
  installDirCommands.forEach((path, command) => options.outsidePath?.set(command, path))
  return foundCommands
}
