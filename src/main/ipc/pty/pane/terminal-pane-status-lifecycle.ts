import { agentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import type { Store } from '../../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { toSshExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { collectLeafIds } from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-layout-tree'
import { paneKeyPtyId } from './key-state'
import { ptyIncarnationById } from '../provider/ownership-state'
import { isLocalHookConnectionId } from '../../../../shared/agent-hook-listener/transport/wsl-hook-relay-contract'
import { getProviderForPty } from '../provider/registry'
import { inspectPtyProviderProcess } from '../../../providers/pty/process-inspection'
import { isShellProcess } from '../../../../shared/agent-status/process/shell-process-detection'
import { isRemoteExecutionHostPtyId } from '../../../../shared/execution-host/remote-execution-host-pty-id'
import { confirmRootShellAloneFromProcessTable } from '../../../runtime/terminal/lifecycle/run-terminal-shell-alone'

export function bindTerminalPaneStatusLifecycle(
  runtime: OrcaRuntimeService | undefined,
  store: Store | undefined
): void {
  agentHookServer.setTerminalPaneLifecycle({
    retireSavedRecord: (paneKey, exitedAt) => runtime?.retireExitedPaneResume(paneKey, exitedAt),
    confirmProcessExit: async (paneKey, agent) => {
      if (!runtime) {
        return false
      }
      try {
        const pane = runtime.resolveTerminalPane(paneKey)
        const launch = runtime.getLaunchStatementForPaneKey(paneKey, agent)
        // A finished command already retired a gone launch; an unknown one (reattach) needs the proof.
        if (!pane.ptyId || isRemoteExecutionHostPtyId(pane.ptyId) || launch === null) {
          return false
        }
        const shellAlone = await confirmShellAlone(pane.ptyId, pane.incarnationId ?? undefined)
        const current = runtime.resolveTerminalPane(paneKey)
        return (
          shellAlone === true &&
          current.ptyId === pane.ptyId &&
          current.incarnationId === pane.incarnationId &&
          runtime.getLaunchStatementForPaneKey(paneKey, agent) === launch
        )
      } catch {
        return false
      }
    },
    readSavedRecord: (paneKey) => {
      try {
        const worktreeId = runtime?.getTerminalWorktreeIdForPaneKey(paneKey)
        if (!worktreeId) {
          return undefined
        }
        return runtime?.getWorkspaceSessionForWorktree(worktreeId)
          ?.sleepingAgentSessionsByPaneKey?.[paneKey]
      } catch {
        return undefined
      }
    },
    ownsProcess: (paneKey, ptyId, incarnationId) => {
      const current = paneKeyPtyId.get(paneKey)
      if (current) {
        return (
          current === ptyId && (!incarnationId || ptyIncarnationById.get(current) === incarnationId)
        )
      }
      try {
        const pane = runtime?.resolveTerminalPane(paneKey)
        return pane?.ptyId === ptyId && (!incarnationId || pane.incarnationId === incarnationId)
      } catch {
        return false
      }
    },
    isStopping: (paneKey) => {
      let ptyId = paneKeyPtyId.get(paneKey)
      let incarnationId = ptyId ? ptyIncarnationById.get(ptyId) : undefined
      if (!ptyId && runtime) {
        try {
          const pane = runtime.resolveTerminalPane(paneKey)
          ptyId = pane.ptyId ?? undefined
          incarnationId = pane.incarnationId ?? undefined
        } catch {
          /* An unbound pane has no stopping process. */
        }
      }
      return (
        ptyId !== undefined &&
        (runtime?.intentionalPtyStops.claimExit(ptyId, incarnationId).includes('reversible') ??
          false)
      )
    },
    isReversibleStop: (ptyId, incarnationId) =>
      runtime?.intentionalPtyStops.claimExit(ptyId, incarnationId).includes('reversible') ?? false,
    isPlaced: (row) => {
      if (!store || !row.worktreeId) {
        return undefined
      }
      const parsed = parsePaneKey(row.paneKey)
      if (!parsed) {
        return false
      }
      const session = store.getWorkspaceSession(
        !isLocalHookConnectionId(row.connectionId ?? null) && row.connectionId
          ? toSshExecutionHostId(row.connectionId)
          : undefined
      )
      const tab = session.tabsByWorktree?.[row.worktreeId]?.find((tab) => tab.id === parsed.tabId)
      return Boolean(
        tab &&
        collectLeafIds(session.terminalLayoutsByTabId?.[parsed.tabId]?.root).includes(parsed.leafId)
      )
    }
  })
  agentHookServer.pruneUnplacedSleepingPanes()
}

/** The shell alone holds the PTY, with no job behind it, stopped or running. A daemon answers
 *  shell ownership from prompt marks, so POSIX reads the PTY's root shell from a fresh process
 *  table instead, local or daemon alike. Windows shells stop no jobs, so the host's job census
 *  finding no child beside a shell foreground suffices there. Never fall back to a foreground
 *  name, which a live unrecognized agent shares. */
async function confirmShellAlone(ptyId: string, incarnationId?: string): Promise<boolean> {
  const provider = getProviderForPty(ptyId)
  if (process.platform !== 'win32') {
    const processes = await provider.listProcesses({ ptyIds: [ptyId] }).catch(() => [])
    const rootPid = processes.find((entry) => entry.id === ptyId)?.rootProcessId
    return rootPid
      ? confirmRootShellAloneFromProcessTable(rootPid, { noLiveDescendants: true })
      : false
  }
  if ((await provider.confirmShellForeground?.(ptyId)) === true) {
    return true
  }
  const inspection = await inspectPtyProviderProcess(provider, ptyId, {
    scanChildProcesses: true,
    ...(incarnationId ? { expectedIncarnationId: incarnationId } : {})
  })
  return (
    inspection.childProcessEvidence === 'no-children' &&
    typeof inspection.foregroundProcess === 'string' &&
    isShellProcess(inspection.foregroundProcess)
  )
}
