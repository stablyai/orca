import { createHash } from 'node:crypto'
import { isStructuredWorkerHandle } from '../../../shared/orchestration/workers/structured-worker-handle'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import '../../../shared/orchestration/workers/worker-terminal-host-scope'
import 'zod'
import '../../../shared/agent-session/view/structured-agent-session-projection'
import '../orchestration/addressing/session-lineage/structured-session-lineage'
import '../../../shared/execution-host'
import type { RuntimeAgentOrchestrationDependencies } from '../orchestration/crew/runtime-agent-orchestration-projection'
import type { AgentSenderHandleReads } from './runtime-agent-sender-associations'

/** A live terminal as this host runs it now. */
export type AgentSenderPane = {
  paneKey: string
  worktreeId: string
  handle: string
  processIncarnation: string | null
  hostScope?: string | null
  launchTokenHash?: string | null
}

export function readLiveAgentSenderPanes(
  deps: Pick<
    RuntimeAgentOrchestrationDependencies,
    'getPtys' | 'getLeaves' | 'makePaneKey' | 'paneOf'
  > &
    Pick<AgentSenderHandleReads, 'readLeafHandle' | 'readPtyHandles'>,
  work: { leafVisits: number; ptyVisits: number },
  originalExecution: (handle: string, incarnation: string | null) => boolean
): Map<string, AgentSenderPane & { original: boolean }> {
  const panes = new Map<string, AgentSenderPane & { original: boolean }>()
  const ptys = new Map([...deps.getPtys()].map((pty) => [pty.ptyId, pty]))
  const launchHashes = new Map<string, string | null>()
  const terminal = (
    handle: string | null,
    paneKey: string | null,
    worktreeId: string | null,
    ptyId: string | null
  ) => {
    if (
      !handle ||
      !paneKey ||
      !worktreeId ||
      isStructuredWorkerHandle(handle) ||
      !parsePaneKey(paneKey)
    ) {
      return
    }
    const pty = ptyId ? ptys.get(ptyId) : undefined
    const processIncarnation = pty?.incarnationId ? `${pty.ptyId}:${pty.incarnationId}` : null
    const hostScope = pty?.connectionId
      ? JSON.stringify({ kind: 'ssh', targetId: pty.connectionId })
      : pty?.isWsl || pty?.wslDistro
        ? pty.wslDistro
          ? JSON.stringify({ kind: 'wsl', hostId: 'local', distro: pty.wslDistro })
          : 'unproven'
        : null
    let launchTokenHash = launchHashes.get(ptyId ?? '')
    if (launchTokenHash === undefined) {
      launchTokenHash =
        pty?.launchToken && pty.incarnationId && pty.launchIncarnationId === pty.incarnationId
          ? createHash('sha256').update(pty.launchToken).digest('hex')
          : null
      launchHashes.set(ptyId ?? '', launchTokenHash)
    }
    panes.set(paneKey, {
      paneKey,
      worktreeId,
      handle,
      processIncarnation,
      hostScope,
      launchTokenHash,
      original: originalExecution(handle, processIncarnation)
    })
  }
  for (const leaf of deps.getLeaves()) {
    work.leafVisits++
    if (leaf.ptyId) {
      terminal(deps.readLeafHandle(leaf), deps.makePaneKey(leaf), leaf.worktreeId, leaf.ptyId)
    }
  }
  const readPtyHandle = deps.readPtyHandles()
  for (const pty of ptys.values()) {
    work.ptyVisits++
    const paneKey = deps.paneOf(pty).paneKey
    if (paneKey && !panes.has(paneKey)) {
      terminal(readPtyHandle(pty), paneKey, pty.worktreeId, pty.ptyId)
    }
  }
  return panes
}
