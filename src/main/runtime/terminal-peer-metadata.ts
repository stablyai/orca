import type { RuntimeTerminalSummary } from '../../shared/runtime-terminal-contracts'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

/** Adds Claude peer fields to a listed terminal; any inspection failure returns the terminal unchanged. */
export async function enrichTerminalPeerMetadata(
  terminal: RuntimeTerminalSummary,
  deps: {
    getController: () => RuntimePtyController | null
    getPty: (ptyId: string) => RuntimePtyWorktreeRecord | undefined
  }
): Promise<RuntimeTerminalSummary> {
  const controller = deps.getController()
  if (
    !terminal.connected ||
    terminal.agentIdentity !== 'claude' ||
    !terminal.ptyId ||
    !controller?.inspectProcess
  ) {
    return terminal
  }
  try {
    const pty = deps.getPty(terminal.ptyId)
    const inspection = await controller.inspectProcess(terminal.ptyId, {
      steadyState: true,
      ...(terminal.incarnationId ? { expectedIncarnationId: terminal.incarnationId } : {})
    })
    // An inspection can outlive reattachment or controller replacement.
    if (
      deps.getController() !== controller ||
      deps.getPty(terminal.ptyId) !== pty ||
      pty?.incarnationId !== terminal.incarnationId ||
      !pty?.connected
    ) {
      return terminal
    }
    if ('verdict' in inspection && inspection.verdict === 'unverifiable') {
      return terminal
    }
    return {
      ...terminal,
      ...(inspection.agentName ? { agentName: inspection.agentName } : {}),
      ...(inspection.agentPid ? { agentPid: inspection.agentPid } : {}),
      ...(inspection.permissionMode ? { permissionMode: inspection.permissionMode } : {})
    }
  } catch {
    return terminal
  }
}
