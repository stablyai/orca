import { getAppEnvironment } from '../../shared/app-environment'
import { runProcess } from '../../shared/child-process/run-process'
import {
  buildWslCapturedLoginShellCommand,
  buildWslExecArgs
} from '../../shared/wsl-login-shell-command'
import { getCanonicalUserDataPath } from '../persistence'
import { addOrcaWslInteropEnv } from '../pty/wsl-orca-env'
import { resolveWslExecutablePath } from '../wsl/wsl-executable-path'
import { getManagedWslCliDir, getWslCliCommandName } from './wsl-managed-cli'

const pending = new Map<string, Promise<boolean>>()

async function freshTerminalDaemonSupportsManagedCli(): Promise<boolean> {
  const { getDaemonProvider, daemonOwnsFreshPersistentPtys } =
    await import('../daemon/daemon-provider-state')
  if (!daemonOwnsFreshPersistentPtys()) {
    return true
  }
  const { getCurrentDaemonAdapter } = await import('../daemon/daemon-provider-routing')
  const provider = getDaemonProvider()
  return (
    provider !== null &&
    getCurrentDaemonAdapter(provider).getDaemonIdentity()?.managedWslCli === true
  )
}

async function probe(distro?: string): Promise<boolean> {
  if (process.platform !== 'win32' || !(await freshTerminalDaemonSupportsManagedCli())) {
    return false
  }
  const app = getAppEnvironment()
  const directory = getManagedWslCliDir({
    isPackaged: app.isPackaged(),
    userDataPath: getCanonicalUserDataPath(),
    resourcesPath: process.resourcesPath
  })
  if (!directory) {
    return false
  }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  env.ORCA_WSL_CLI_DIR = directory
  env.ORCA_CLI_COMMAND = getWslCliCommandName(app.isPackaged())
  addOrcaWslInteropEnv(env)
  env.WSL_UTF8 = '1'
  const captured = buildWslCapturedLoginShellCommand(
    [
      'case "${0##*/}" in',
      '  bash|-bash) test -s "$ORCA_SHELL_READY_ROOT/bash/rcfile" || exit 1 ;;',
      '  zsh|-zsh) test -s "$ORCA_SHELL_READY_ROOT/zsh/.zshenv" || exit 1 ;;',
      '  *) exit 1 ;;',
      'esac',
      '"$ORCA_WSL_CLI_DIR/$ORCA_CLI_COMMAND" --version >/dev/null || exit 1',
      'printf managed-cli-ready'
    ].join('\n')
  )
  const result = await runProcess({
    program: resolveWslExecutablePath(),
    args: buildWslExecArgs(distro, ['sh', '-c', captured.command]),
    env,
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024
  })
  return (
    result.code === 0 &&
    captured.readStdout(result.stdout) === 'managed-cli-ready' &&
    (await freshTerminalDaemonSupportsManagedCli())
  )
}

/** Coalesce panels checking the same distro, without retaining evidence across daemon restarts. */
export function isManagedWslCliAvailable(distro?: string): Promise<boolean> {
  const key = distro?.trim() || ''
  const existing = pending.get(key)
  if (existing) {
    return existing
  }
  const operation = probe(key || undefined).finally(() => pending.delete(key))
  pending.set(key, operation)
  return operation
}
