import type { PreparedRestoredPaneStartup } from './prepared-pane-replacement'
import type { TerminalWorkspaceLaunchScope } from '../../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type {
  MobileTerminalCommand,
  MobileTerminalResumeCommand
} from '../launch/mobile-terminal-startup'

export async function prepareRestoredPaneStartup({
  resolveResume,
  resolveWorkspace,
  resolveCommand,
  resolveLaunchRuntime,
  launchAgent
}: {
  resolveResume: () => Promise<PreparedRestoredPaneStartup['resumeStartup']>
  resolveWorkspace: () => Promise<TerminalWorkspaceLaunchScope>
  resolveCommand: (workspace: TerminalWorkspaceLaunchScope) => Promise<MobileTerminalCommand>
  resolveLaunchRuntime: (workspace: TerminalWorkspaceLaunchScope) => unknown
  launchAgent: TuiAgent | undefined
}): Promise<PreparedRestoredPaneStartup> {
  const resumeStartup = await resolveResume()
  let agentStartup: MobileTerminalCommand | MobileTerminalResumeCommand = resumeStartup ?? {}
  if (resumeStartup === undefined && launchAgent) {
    let workspace
    try {
      workspace = await resolveWorkspace()
      agentStartup = await resolveCommand(workspace)
    } catch {
      if (workspace) {
        resolveLaunchRuntime(workspace)
      }
    }
  }
  return { resumeStartup, agentStartup }
}
