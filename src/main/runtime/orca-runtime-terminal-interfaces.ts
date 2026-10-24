import { createKeyedTrailingEdgeCoalescer } from './keyed-trailing-edge-coalescer'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { isAgentLaunchRunningIn } from '../agent-launch/agent-launch-pane-attachment'
import type { TerminalInterfaceTarget } from '../agent-hooks/server/terminal-interface-authority'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import { OrcaRuntimeWithAgentTransitions } from './orca-runtime-agent-transitions'
import { OrcaRuntimeWithSidebarTemporal } from './sidebar-inputs/orca-runtime-sidebar-temporal'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../shared/sidebar-inputs-switch'

// Switch point: a window-fed build keeps no sidebar facts layer.
const OrcaRuntimeSidebarBase: typeof OrcaRuntimeWithAgentTransitions = ORCA_SIDEBAR_INPUTS_IS_MAIN
  ? OrcaRuntimeWithSidebarTemporal
  : OrcaRuntimeWithAgentTransitions

export abstract class OrcaRuntimeWithTerminalInterfaces extends OrcaRuntimeSidebarBase {
  getTerminalInterfaceClientEventSnapshot(): RuntimeClientEvent[] {
    const authority = this.terminalInterfaces
    return authority ? [authority.snapshotEvent()] : []
  }

  protected installTerminalInterfaceHost(): void {
    if (this.terminalInterfaces) {
      const authority = this.terminalInterfaces
      const offInput = this.terminalRunFacts.onObservationInput((ptyId, kind) =>
        authority.input(ptyId, kind)
      )
      const changes = createKeyedTrailingEdgeCoalescer(
        () => this.emitClientEvent(authority.snapshotEvent()),
        { flushMs: 0, maxWaitMs: 250 }
      )
      const stop = authority.install({
        dispose: () => {
          offInput()
          changes.flushAll()
          changes.dispose()
        },
        inventory: (ptyId) => this.terminalInterfaceInventory(ptyId),
        inspect: (binding, steadyState) =>
          this.ptyController?.inspectProcess?.(binding.ptyId, {
            expectedIncarnationId: binding.incarnationId,
            scanChildProcesses: true,
            terminalInterface: true,
            steadyState
          }) ?? Promise.resolve(null),
        changed: () => changes.schedule('terminal-interfaces')
      })
      this.registerSubscriptionCleanup('terminal-interface-host', stop)
    }
  }
  private terminalInterfaceInventory(ptyId?: string): TerminalInterfaceTarget[] {
    const target = ptyId === undefined ? undefined : this.ptysById.get(ptyId)
    const terminals = ptyId === undefined ? this.ptysById.values() : target ? [target] : []
    return [...terminals].flatMap((pty) => {
      if (!pty.connected || !pty.incarnationId || pty.connectionId !== null || pty.isWsl === true) {
        return []
      }
      const terminalHandle = this.handleByPtyId.get(pty.ptyId)
      if (!terminalHandle) {
        return []
      }
      const { paneKey } = this.paneOfPty(pty)
      if (!paneKey) {
        return []
      }
      const pane = parsePaneKey(paneKey)
      return [
        {
          binding: {
            ptyId: pty.ptyId,
            incarnationId: pty.incarnationId,
            paneKey,
            worktreeId: pty.worktreeId,
            terminalHandle
          },
          generation: this.getPtyLifecycleGeneration(pty.ptyId),
          launchToken: pty.launchToken ?? null,
          local: true,
          blocked:
            this.intentionalPtyStops.hasStop(pty.ptyId, pty.incarnationId) ||
            (pane !== null && isAgentLaunchRunningIn(pty.worktreeId, { kind: 'pane', ...pane })) ||
            this.isWorktreeTerminalSleepHeld(pty.worktreeId) ||
            this.terminalPaneRecoveryByIdentity.has(`${pty.worktreeId}\0${paneKey}`)
        }
      ]
    })
  }
}
