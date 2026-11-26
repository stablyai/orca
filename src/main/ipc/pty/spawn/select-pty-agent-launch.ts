import { resolveLocalWindowsAgentStartupShell } from '../../../../shared/shell/launch/windows-terminal-shell'
import { resolveStartupShell } from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { GENERATED_AGENT_LAUNCH_ENV } from '../../../../shared/agent-launch/startup/generated-agent-launch-inputs'
import {
  ORCA_HERMES_STARTUP_QUERY_ARGV_ENV,
  ORCA_HERMES_STARTUP_QUERY_ENV
} from '../../../../shared/agent-launch/startup/hermes-startup-query'
import {
  SETUP_AGENT_SEQUENCE_MARKER_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV
} from '../../../../shared/agent-launch/startup/setup-agent-sequencing'
import { alignManagedAgentLaunchAtSpawn } from '../../../managed-agent-cli/managed-agent-spawn-program'
import type { PtySpawnLaunchOptionsInput } from './spawn-options-assembly'
import { waitForSequencedSetup } from './wait-for-sequenced-setup'

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
    ? input.env?.[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]
      ? 'posix'
      : 'powershell'
    : paneShell
  const marker = input.env?.[SETUP_AGENT_SEQUENCE_MARKER_ENV]
  const waitForSetup =
    Boolean(sequenced && marker) &&
    !connectionId &&
    !input.preAdoptedStablePane &&
    input.launchConfig?.commandProvenance === 'generated'
  const setupExit = waitForSetup && marker ? await waitForSequencedSetup(marker, args.signal) : 0
  const command = setupExit === 0 ? sequenced || input.launchCommand : undefined
  const {
    command: startupCommand,
    launchConfig,
    blocked: selectionBlocked,
    rebuiltHermesQuery
  } = await alignManagedAgentLaunchAtSpawn(
    {
      ...input,
      launchCommand: command,
      launchAgent,
      ...(waitForSetup ? { refreshAgentProgram: true } : {}),
      shellPath: process.platform === 'win32' ? undefined : input.shellOverride,
      preselectedAgentProgram: args.preselectedAgentProgram,
      restoring: Boolean(args.resumeProviderSession) || args.resumeOrigin === 'saved',
      nativeChatSignIn: args.nativeChatSignIn,
      sshTarget: Boolean(connectionId),
      ...(sequenced ? { sourceShell: paneShell } : {})
    },
    shell
  )
  let paneEnv = input.env
  if (
    paneEnv &&
    (GENERATED_AGENT_LAUNCH_ENV in paneEnv ||
      ORCA_HERMES_STARTUP_QUERY_ARGV_ENV in paneEnv ||
      SETUP_AGENT_SEQUENCE_MARKER_ENV in paneEnv)
  ) {
    paneEnv = { ...paneEnv }
    delete paneEnv[GENERATED_AGENT_LAUNCH_ENV]
    delete paneEnv[SETUP_AGENT_SEQUENCE_MARKER_ENV]
    delete paneEnv[ORCA_HERMES_STARTUP_QUERY_ARGV_ENV]
    if (selectionBlocked || setupExit !== 0) {
      delete paneEnv[ORCA_HERMES_STARTUP_QUERY_ENV]
    }
  }
  return {
    launchAgent,
    shell,
    platform,
    sequenced,
    startupCommand,
    launchConfig,
    selectionBlocked: selectionBlocked ?? (setupExit !== 0 ? 'unknown' : undefined),
    setupExit,
    waitForSetup,
    rebuiltHermesQuery,
    paneEnv
  }
}
