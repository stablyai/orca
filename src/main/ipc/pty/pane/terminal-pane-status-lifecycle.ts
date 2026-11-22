import { agentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import type { Store } from '../../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { toSshExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { collectLeafIds } from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-layout-tree'
import { paneKeyPtyId } from './key-state'
import { ptyIncarnationById } from '../provider/ownership-state'
import { getRegisteredPtyPid } from '../../../memory/pty-registry'
import { isLocalHookConnectionId } from '../../../../shared/agent-hook-listener/transport/wsl-hook-relay-contract'
import { getProviderForPty } from '../provider/registry'
import { inspectPtyProviderProcess } from '../../../providers/pty/process-inspection'
import { isShellProcess } from '../../../../shared/agent-status/process/shell-process-detection'
import { isRemoteExecutionHostPtyId } from '../../../../shared/execution-host/remote-execution-host-pty-id'
import {
  confirmRootShellAloneFromProcessTable,
  paneAgentProcess
} from '../../../runtime/terminal/lifecycle/run-terminal-shell-alone'

export function bindTerminalPaneStatusLifecycle(
  runtime: OrcaRuntimeService | undefined,
  store: Store | undefined
): void {
  agentHookServer.setTerminalPaneLifecycle({
    retireSavedRecord: (paneKey, exitedAt) => runtime?.retireExitedPaneResume(paneKey, exitedAt),
    agentExited: (paneKey) => runtime?.observeWorkerAgentExit(paneKey),
    modelWaitElapsed: async (paneKey, wait) =>
      (await runtime?.observeWorkerModelWait(paneKey, wait)) ?? false,
    confirmProcessExit: async (paneKey, agent) => {
      if (!runtime) {
        return false
      }
      try {
        const launchOf = () => {
          const { ptyId } = resolvePanePty(runtime, paneKey)
          return ptyId ? runtime.getLaunchStatementForPty(ptyId, agent) : null
        }
        // A typed agent holds no launch, and a shell without command marks (cmd.exe) says nothing
        // when it quits, so the proof stands on its own; a launch replaced meanwhile voids it.
        const launch = launchOf()
        return await paneShellAlone(runtime, paneKey, agent, () => launchOf() === launch)
      } catch {
        return false
      }
    },
    // Windows gives a command mark no proof against a nested shell, so the mark stands, as on main.
    confirmShellAlone: async (paneKey, agent) =>
      process.platform === 'win32' ? null : paneShellAlone(runtime, paneKey, agent),
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
  agentHookServer.pruneUnplacedPanes()
}

/** A local pane's shell alone holds its PTY, and the pane still runs that PTY afterwards; null on
 *  a remote host, which reports no process tree to main. */
/** The pane's PTY from the spawn-time index, else the runtime's pane search. */
function resolvePanePty(
  runtime: OrcaRuntimeService,
  paneKey: string
): { ptyId: string | null; incarnationId: string | null } {
  const ptyId = paneKeyPtyId.get(paneKey)
  if (ptyId) {
    return { ptyId, incarnationId: ptyIncarnationById.get(ptyId) ?? null }
  }
  const pane = runtime.resolveTerminalPane(paneKey)
  return { ptyId: pane.ptyId ?? null, incarnationId: pane.incarnationId ?? null }
}

async function paneShellAlone(
  runtime: OrcaRuntimeService | undefined,
  paneKey: string,
  agent: string | undefined,
  stillCurrent: () => boolean = () => true
): Promise<boolean | null> {
  if (!runtime) {
    return false
  }
  try {
    const pane = resolvePanePty(runtime, paneKey)
    if (!pane.ptyId) {
      return false
    }
    if (isRemoteExecutionHostPtyId(pane.ptyId)) {
      return null
    }
    // Input during the proof (desktop, CLI or mobile) may start the next agent (`codex resume`)
    // after the table was read; run facts skip a terminal's automatic query replies.
    const inputStamp = (ptyId: string): number | null =>
      runtime.terminalRunFacts.readLastInputAt(ptyId)
    const inputBefore = inputStamp(pane.ptyId)
    const shellAlone = await confirmShellAlone(pane.ptyId, pane.incarnationId ?? undefined, agent)
    const current = resolvePanePty(runtime, paneKey)
    return (
      shellAlone &&
      inputStamp(pane.ptyId) === inputBefore &&
      current.ptyId === pane.ptyId &&
      current.incarnationId === pane.incarnationId &&
      stillCurrent()
    )
  } catch {
    return false
  }
}

/** The shell alone holds the PTY, with no stopped job behind it. A daemon answers
 *  shell ownership from prompt marks, so POSIX reads the PTY's root shell from a fresh process
 *  table instead, local or daemon alike. Windows shells stop no jobs, so the host's job census
 *  finding no child beside a shell foreground suffices there. Never fall back to a foreground
 *  name, which a live unrecognized agent shares. */
async function confirmShellAlone(
  ptyId: string,
  incarnationId?: string,
  agent?: string
): Promise<boolean | null> {
  const provider = getProviderForPty(ptyId)
  if (process.platform !== 'win32') {
    // Spawn and adoption publish the shell's PID; a host that published none (an older daemon)
    // gives no proof, so the mark stands there, as on main.
    const rootPid = getRegisteredPtyPid(ptyId)
    return rootPid
      ? confirmRootShellAloneFromProcessTable(rootPid, { paneAgent: paneAgentProcess(agent) })
      : null
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
