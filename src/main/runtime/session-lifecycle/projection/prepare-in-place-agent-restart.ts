import {
  agentLaunchQuotingShell,
  type AgentLaunchRuntime
} from '../../../../shared/agent-launch/startup/agent-launch-runtime'
import { resolveWslSessionContext } from '../../../daemon/pty-subprocess/wsl-session-context'
import { getCodexSelectionTargetForPty } from '../../../ipc/pty/host-env/codex-home'
import {
  alignManagedAgentLaunchAtSpawn,
  type PreselectedAgentProgram
} from '../../../managed-agent-cli/managed-agent-spawn-program'
import type { MobileTerminalResumeCommand } from '../../terminal/launch/mobile-terminal-startup'

/** Verify the replacement before stopping, then reuse its selection at spawn. */
export async function prepareInPlaceAgentRestart(
  resume: MobileTerminalResumeCommand,
  launchRuntime: AgentLaunchRuntime,
  cwd: string
): Promise<{
  launchRuntime: AgentLaunchRuntime
  preselectedAgentProgram: PreselectedAgentProgram | undefined
} | null> {
  const { shellOverride } = launchRuntime.pty
  const expectedWslDistro = resolveWslSessionContext({ cwd, ...launchRuntime.pty })?.distro
  const codexRuntime = getCodexSelectionTargetForPty(shellOverride, cwd, expectedWslDistro).runtime
  let program: PreselectedAgentProgram | undefined
  let restartRuntime = launchRuntime
  const aligned = await alignManagedAgentLaunchAtSpawn(
    {
      launchCommand: resume.command,
      launchConfig: resume.launchConfig,
      launchAgent: resume.launchAgent,
      env: resume.env,
      cwd,
      shellPath: shellOverride,
      codexRuntime,
      expectedWslDistro,
      restoring: true
    },
    agentLaunchQuotingShell(launchRuntime),
    (selected) => {
      program = selected
      if (selected.wslDistro) {
        restartRuntime = {
          ...launchRuntime,
          pty: { ...launchRuntime.pty, terminalWindowsWslDistro: selected.wslDistro }
        }
      }
    }
  )
  return aligned.blocked
    ? null
    : { launchRuntime: restartRuntime, preselectedAgentProgram: program }
}
