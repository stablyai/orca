import { win32 } from 'node:path'
import type {
  PreparedAgentLaunch,
  QueuedAgentLaunch
} from '../../shared/agent-launch/startup/queued-agent-launch'
import { prepareShellNativeAgentLaunch } from '../../shared/agent-launch/startup/codex-startup-image-command'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import {
  canonicalizeWindowsShellOverride,
  resolveWindowsShellStartupFamily
} from '../../shared/shell/launch/windows-terminal-shell'
import { parseExecutionHostId } from '../../shared/execution-host/execution-host'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { resolvePtyExecutionHost } from '../ipc/pty/provider/registry'
import { ptyShellPath } from '../providers/local-pty/local-pty-provider-state'
import { alignManagedAgentLaunchAtSpawn } from '../managed-agent-cli/managed-agent-spawn-program'
import { assertWslDistroRunningForExec } from '../wsl/discovery/wsl-background-exec-gate'

type LaunchSettings = Partial<
  Pick<
    GlobalSettings,
    | 'agentCmdOverrides'
    | 'antigravityManagedAgyEnabled'
    | 'terminalDefaultShell'
    | 'terminalInlineImages'
    | 'terminalWindowsShell'
  >
>

type QueuedLaunchPty = NonNullable<ReturnType<OrcaRuntimeService['readQueuedLaunchPty']>>

export async function prepareQueuedAgentLaunch(
  runtime: Pick<OrcaRuntimeService, 'readQueuedLaunchPty'>,
  ptyId: string,
  launch: QueuedAgentLaunch,
  settings: LaunchSettings | undefined
): Promise<PreparedAgentLaunch> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const pty = runtime.readQueuedLaunchPty(ptyId)
    const owner = parseExecutionHostId(resolvePtyExecutionHost(ptyId))
    if (!pty || (owner?.kind !== 'local' && owner?.kind !== 'ssh')) {
      break
    }
    const recordedShell = ptyShellPath.get(ptyId)
    const isCurrent = () =>
      pty.isCurrent() &&
      resolvePtyExecutionHost(ptyId) === owner.id &&
      ptyShellPath.get(ptyId) === recordedShell
    try {
      const ssh = owner.kind === 'ssh' || Boolean(pty.connectionId)
      const preparedCommand = await prepareForPty(pty, ssh, recordedShell, launch, settings)
      if (isCurrent()) {
        return { preparedCommand }
      }
    } catch (error) {
      if (isCurrent()) {
        throw error
      }
    }
  }
  return { preparedCommand: null }
}

async function prepareForPty(
  pty: QueuedLaunchPty,
  ssh: boolean,
  recordedShell: string | undefined,
  launch: QueuedAgentLaunch,
  settings: LaunchSettings | undefined
): Promise<string> {
  const foreground =
    !ssh && !recordedShell && !pty.wslDistro && process.platform === 'win32'
      ? await pty.readForegroundProcess()
      : undefined
  const observedWindowsShell = foreground
    ? canonicalizeWindowsShellOverride(win32.basename(foreground))
    : undefined
  const requestedWindowsShell = launch.shellOverride
    ? canonicalizeWindowsShellOverride(launch.shellOverride)
    : undefined
  const observedShell = recordedShell ?? observedWindowsShell
  const ptyShell = observedShell ?? requestedWindowsShell
  const shellPreference =
    ptyShell ??
    (process.platform === 'win32' ? settings?.terminalWindowsShell : settings?.terminalDefaultShell)
  const wslShell = pty.isWsl == null ? shellPreference : observedShell
  const wsl =
    !ssh &&
    process.platform === 'win32' &&
    Boolean(pty.wslDistro || pty.isWsl || /^wsl(?:\.exe)?$/i.test(win32.basename(wslShell ?? '')))
  if (wsl) {
    await assertWslDistroRunningForExec(pty.wslDistro)
  }
  const shell = ssh
    ? launch.shell
    : process.platform === 'win32' && !wsl
      ? resolveWindowsShellStartupFamily(shellPreference)
      : 'posix'
  const command = await alignManagedAgentLaunchAtSpawn(
    {
      launchCommand: launch.command,
      codexRuntime: wsl ? 'wsl' : 'host',
      sshTarget: ssh,
      cwd: launch.cwd,
      readCwd: pty.readCwd,
      queuedPath: launch.path,
      shellOverride: process.platform === 'win32' ? ptyShell : shellPreference,
      getSettings: () => settings
    },
    shell
  )
  return prepareShellNativeAgentLaunch(
    command ?? launch.command,
    shell,
    launch.images !== false && settings?.terminalInlineImages !== false
  )
}
