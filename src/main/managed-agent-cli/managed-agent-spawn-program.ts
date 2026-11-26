import {
  isFreshOmpLaunchCommand,
  prepareFreshOmpLaunch
} from '../../shared/agent-launch/startup/omp-fresh-launch'
import type { AgentStartupShell } from '../../shared/agent-launch/startup/tui-agent-startup-shell'
import type { NativeChatSignInRequest } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { prepareNativeChatSignIn } from './prepare-native-chat-sign-in'
import type { PreselectedAgentProgram } from './spawn-agent-program-selection'
import {
  rewriteLaunchExecutable,
  type AgentExecutableLaunch,
  type AlignedLaunch
} from './managed-agent-spawn-executable'

export type { PreselectedAgentProgram } from './spawn-agent-program-selection'

type SpawnLaunch = AgentExecutableLaunch & {
  launchCommand: string | undefined
  nativeChatSignIn?: NativeChatSignInRequest
  getSettings?: () => Parameters<typeof prepareNativeChatSignIn>[1] | undefined
}

export async function alignManagedAgentLaunchAtSpawn(
  spawn: SpawnLaunch,
  shell: AgentStartupShell,
  onProgramSelected?: (program: PreselectedAgentProgram) => void
): Promise<AlignedLaunch> {
  const command = spawn.launchCommand
  const config = spawn.launchConfig
  if (!command) {
    return { command, launchConfig: config }
  }
  if (spawn.nativeChatSignIn) {
    const prepared = await prepareNativeChatSignIn(
      spawn.sshTarget
        ? { kind: 'ssh', connectionId: '' }
        : {
            kind: 'local',
            context: spawn.codexRuntime === 'wsl' ? { wslDefault: true } : undefined
          },
      spawn.getSettings?.() ?? {},
      spawn.nativeChatSignIn,
      shell
    )
    return { command: prepared ?? command, launchConfig: config }
  }
  if (spawn.sshTarget && !(spawn.sourceShell === 'cmd' && shell === 'powershell')) {
    return { command, launchConfig: config }
  }
  if (isFreshOmpLaunchCommand(command)) {
    let aligned: AlignedLaunch | undefined
    const source = spawn.sourceShell ?? shell
    const guarded = await prepareFreshOmpLaunch(
      command,
      source,
      async (inner) => {
        aligned = await rewriteLaunchExecutable(spawn, shell, inner, onProgramSelected)
        return aligned.command ?? inner
      },
      shell
    )
    return aligned
      ? { ...aligned, command: aligned.blocked ? undefined : guarded }
      : spawn.setupGate && config?.commandProvenance === 'generated'
        ? { command: undefined, launchConfig: config, blocked: 'unknown' }
        : { command, launchConfig: config }
  }
  return rewriteLaunchExecutable(spawn, shell, command, onProgramSelected)
}
