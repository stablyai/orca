import { agentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import type { Store } from '../../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { toSshExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { collectLeafIds } from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-layout-tree'
import { paneKeyPtyId } from './key-state'
import { ptyFallbackRootPidById, ptyIncarnationById } from '../provider/ownership-state'
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
    confirmProcessExit: async (paneKey, agent) => {
      try {
        const launch = runtime?.getLaunchStatementForPaneKey(paneKey, agent)
        // A finished command already retired a gone launch; an unknown one (reattach) needs the proof.
        return (
          launch !== null &&
          (await paneShellAlone(
            runtime,
            paneKey,
            agent,
            () => runtime?.getLaunchStatementForPaneKey(paneKey, agent) === launch
          )) === true
        )
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
  agentHookServer.pruneUnplacedSleepingPanes()
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
// Spawn and adoption publish the shell PID; a host that published none pays one targeted
// inventory per PTY incarnation, whose answer (a root or none) lasts until the PTY's teardown.
async function readPtyRootPid(
  provider: ReturnType<typeof getProviderForPty>,
  ptyId: string,
  incarnationId: string | undefined
): Promise<number | undefined> {
  const registered = getRegisteredPtyPid(ptyId)
  if (registered) {
    return registered
  }
  const known = ptyFallbackRootPidById.get(ptyId)
  if (known && known.incarnationId === incarnationId) {
    return known.rootPid ?? undefined
  }
  const processes = await provider
    .listProcesses({ ptyIds: [ptyId], targetOwnerOnly: true })
    .catch(() => null)
  const rootPid = processes?.find((entry) => entry.id === ptyId)?.rootProcessId
  if (processes && incarnationId && ptyIncarnationById.get(ptyId) === incarnationId) {
    ptyFallbackRootPidById.set(ptyId, { incarnationId, rootPid: rootPid ?? null })
  }
  return rootPid
}

async function confirmShellAlone(
  ptyId: string,
  incarnationId?: string,
  agent?: string
): Promise<boolean> {
  const provider = getProviderForPty(ptyId)
  if (process.platform !== 'win32') {
    const rootPid = await readPtyRootPid(provider, ptyId, incarnationId)
    return rootPid
      ? confirmRootShellAloneFromProcessTable(rootPid, {
          paneAgent: paneAgentProcess(agent)
        })
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
