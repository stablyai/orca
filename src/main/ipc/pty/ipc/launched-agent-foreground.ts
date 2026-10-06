import { getPtyIpc } from '../../pty-host-bindings'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { TerminalForegroundVerdict } from '../../../runtime/terminal-foreground-group'

/** The renderer's launch-prompt receipt asks #24257's crash-guard question, keeping the launched
 *  agent named on its command line apart from any other process that is not the shell. */
export function installLaunchedAgentForegroundIpcHandler(
  runtime: OrcaRuntimeService | undefined
): void {
  getPtyIpc().handle(
    'pty:readLaunchedAgentForeground',
    async (_event, args: { id: string; agent: string }): Promise<TerminalForegroundVerdict> => {
      if (!runtime || typeof args?.id !== 'string' || !isTuiAgent(args.agent)) {
        return 'unknown'
      }
      return runtime.readTerminalForegroundVerdict(args.id, args.agent)
    }
  )
}
