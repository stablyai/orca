import { resolveLocalWindowsAgentStartupShell } from '../../../../shared/shell/launch/windows-terminal-shell'
import { resolveStartupShell } from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { GENERATED_AGENT_LAUNCH_ENV } from '../../../../shared/agent-launch/startup/generated-agent-launch-inputs'
import {
  ORCA_HERMES_STARTUP_QUERY_ARGV_ENV,
  ORCA_HERMES_STARTUP_QUERY_ENV
} from '../../../../shared/agent-launch/startup/hermes-startup-query'
import {
  SETUP_AGENT_SEQUENCE_POWERSHELL_SCRIPT_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV
} from '../../../../shared/agent-launch/startup/setup-agent-sequencing'
import { alignManagedAgentLaunchAtSpawn } from '../../../managed-agent-cli/managed-agent-spawn-program'
import type { PtySpawnLaunchOptionsInput } from './spawn-options-assembly'

export async function selectPtyAgentLaunch(input: PtySpawnLaunchOptionsInput) {
  const { args } = input
  const connectionId = args.connectionId ?? undefined
  const launchAgent = isTuiAgent(args.launchAgent) ? args.launchAgent : undefined
  const platform = input.codexRuntime === 'wsl' ? 'linux' : process.platform
  const paneShell = resolveStartupShell(
    platform,
    resolveLocalWindowsAgentStartupShell({
      platform: process.platform,
      isRemote: Boolean(connectionId) || input.codexRuntime === 'wsl',
      terminalWindowsShell: input.shellOverride ?? input.getSettings?.()?.terminalWindowsShell
    })
  )
  // The setup gate's existing carrier holds the actual launch, including any Agent Teams flags.
  const sequenced = input.launchCommand && input.env?.[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]
  const shell = sequenced
    ? input.env?.[SETUP_AGENT_SEQUENCE_POWERSHELL_SCRIPT_ENV]
      ? 'powershell'
      : 'posix'
    : paneShell
  let wslDistro = input.expectedWslDistro
  const {
    command: startupCommand,
    launchConfig,
    blocked: selectionBlocked,
    rebuiltHermesQuery,
    postSetupProgram,
    receivingShellCheck
  } = await alignManagedAgentLaunchAtSpawn(
    {
      ...input,
      signal: args.signal,
      launchCommand: sequenced || input.launchCommand,
      launchAgent,
      shellPath: process.platform === 'win32' ? undefined : input.shellOverride,
      receivingShellPath:
        sequenced && shell === 'posix'
          ? 'bash'
          : input.shellOverride || input.getSettings?.()?.terminalDefaultShell?.trim(),
      preselectedAgentProgram:
        !sequenced || args.preselectedAgentProgram?.shell === shell
          ? args.preselectedAgentProgram
          : undefined,
      restoring: Boolean(args.resumeProviderSession) || args.resumeOrigin === 'saved',
      nativeChatSignIn: args.nativeChatSignIn,
      sshTarget: Boolean(connectionId),
      ...(sequenced
        ? {
            sourceShell: paneShell,
            setupGate:
              !connectionId &&
              !input.preAdoptedStablePane &&
              input.launchConfig?.commandProvenance === 'generated'
          }
        : {})
    },
    shell,
    sequenced
      ? (selected) => {
          wslDistro = selected.wslDistro ?? wslDistro
        }
      : undefined
  )
  let paneEnv = input.env
  if (
    paneEnv &&
    (GENERATED_AGENT_LAUNCH_ENV in paneEnv || ORCA_HERMES_STARTUP_QUERY_ARGV_ENV in paneEnv)
  ) {
    paneEnv = { ...paneEnv }
    delete paneEnv[GENERATED_AGENT_LAUNCH_ENV]
    delete paneEnv[ORCA_HERMES_STARTUP_QUERY_ARGV_ENV]
    if (selectionBlocked) {
      delete paneEnv[ORCA_HERMES_STARTUP_QUERY_ENV]
    }
  }
  return {
    launchAgent,
    shell,
    paneShell,
    platform,
    sequenced,
    startupCommand,
    launchConfig,
    selectionBlocked,
    postSetupProgram,
    receivingShellCheck,
    rebuiltHermesQuery,
    wslDistro,
    paneEnv
  }
}
