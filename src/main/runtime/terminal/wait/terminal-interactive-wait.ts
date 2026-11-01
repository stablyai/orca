import { resolveStructuredWorkerAuthority } from '../../structured-worker-authority'
import { OrcaRuntimeWithOrchestrationAgentLaunch } from '../launch/orchestration-agent-launch'
import type {
  RuntimeTerminalAgentStatus,
  RuntimeTerminalInteractiveWait,
  RuntimeTerminalWaitBlockedReason
} from '../../../../shared/runtime-terminal-contracts'
import type { RuntimeTerminalAgentStatusSnapshot } from '../../runtime-terminal-agent-status-query'
import type {
  TerminalInteractiveWaitEvidence,
  TerminalWaitPermissionInputs,
  TerminalWaitStatusEvidence
} from './terminal-wait-permission'
import { withTimeout } from '../../runtime-async-boundaries'
import { TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS } from '../../orca-runtime-core'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { ExactWorkerProviderSession } from '../../../../shared/orchestration-worker-output'
import { selectExactWorkerProviderSession } from '../../orchestration/worker-provider-session'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'

export abstract class OrcaRuntimeWithGetTerminalInteractiveWait extends OrcaRuntimeWithOrchestrationAgentLaunch {
  protected abstract getTerminalAgentStatusPtyId(handle: string): string

  protected abstract getTerminalWaitPermissionInputs(
    handle: string,
    ptyId: string,
    waitTextOverride?: string
  ): TerminalWaitPermissionInputs

  protected abstract resolveAuthoritativeTerminalWaitPermission(
    terminal: RuntimeTerminalAgentStatusSnapshot,
    explicitStatus: TerminalWaitStatusEvidence,
    lifecycle: TerminalWaitPermissionInputs['lifecycle'],
    observedOnScreen?: boolean
  ): RuntimeTerminalWaitBlockedReason | null

  protected abstract readTerminalInteractiveWaitEvidence(
    handle: string,
    ptyId: string
  ): TerminalInteractiveWaitEvidence | Promise<TerminalInteractiveWaitEvidence | undefined>

  abstract getTerminalAgentStatus(handle: string): Promise<RuntimeTerminalAgentStatus>

  protected abstract getLeafKey(tabId: string, leafId: string): string

  protected abstract getPtyRecordForPaneKey(paneKey: string): RuntimePtyWorktreeRecord | null

  protected abstract getOrchestrationDbIfAvailable(): OrchestrationDb | null

  async getTerminalInteractiveWait(
    handle: string
  ): Promise<RuntimeTerminalInteractiveWait | null | undefined> {
    let ptyId: string
    let evidence: TerminalInteractiveWaitEvidence | undefined
    try {
      ptyId = this.getTerminalAgentStatusPtyId(handle)
      const read = this.readTerminalInteractiveWaitEvidence(handle, ptyId)
      // Why not always await: a hook-status probe must start in this tick so concurrent queries share it.
      evidence = read instanceof Promise ? await read : read
    } catch {
      return undefined
    }
    if (!evidence) {
      return undefined
    }
    const { terminal, explicitStatus, promptReason } = evidence
    if (promptReason) {
      return {
        source: 'prompt-text',
        reason: promptReason,
        ...(terminal.waitBlockedAt !== null ? { since: terminal.waitBlockedAt } : {})
      }
    }
    if (terminal.titleStatus === 'permission' && terminal.titleStatusIsLive) {
      return { source: 'title' }
    }
    if (explicitStatus?.status !== 'permission') {
      return evidence.unconfirmed ? undefined : null
    }
    const status = await withTimeout(
      this.probeAgentStatusOncePerPty(handle, ptyId),
      TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS,
      undefined
    )
    if (!status) {
      return undefined
    }
    return status.isRunningAgent && status.status === 'permission'
      ? { source: 'hook', since: explicitStatus.updatedAt }
      : null
  }

  protected probeAgentStatusOncePerPty(
    handle: string,
    ptyId: string
  ): Promise<RuntimeTerminalAgentStatus | undefined> {
    const inFlight = this.interactiveWaitProbesByPtyId.get(ptyId)
    if (inFlight) {
      return inFlight
    }
    const probe = this.getTerminalAgentStatus(handle)
      .catch(() => undefined)
      .finally(() => {
        if (this.interactiveWaitProbesByPtyId.get(ptyId) === probe) {
          this.interactiveWaitProbesByPtyId.delete(ptyId)
        }
      })
    this.interactiveWaitProbesByPtyId.set(ptyId, probe)
    return probe
  }

  getTerminalWorktreeIdForPaneKey(paneKey: string): string | null {
    const parsed = parsePaneKey(paneKey)
    const leaf = parsed ? this.leaves.get(this.getLeafKey(parsed.tabId, parsed.leafId)) : null
    return leaf?.worktreeId ?? this.getPtyRecordForPaneKey(paneKey)?.worktreeId ?? null
  }

  // Prefer stored workspace selection, then the current renderer graph.
  async resolveActiveWorktreeContext(): Promise<{
    worktreeId: string
    path: string
    branch: string
    displayName: string
  } | null> {
    let worktreeId = this.store?.getWorkspaceSession?.()?.activeWorktreeId ?? null
    if (!worktreeId && this.graphStatus === 'ready') {
      for (const tab of this.tabs.values()) {
        if (tab.activeLeafId && tab.worktreeId) {
          worktreeId = tab.worktreeId
          break
        }
      }
    }
    if (!worktreeId) {
      return null
    }
    try {
      const resolved = await this.resolveWorkspaceSelector(`id:${worktreeId}`)
      return {
        worktreeId: resolved.id,
        path: resolved.git.path,
        branch: resolved.git.branch,
        displayName: resolved.displayName
      }
    } catch {
      return null
    }
  }

  getTerminalProcessIncarnation(handle: string): string | null {
    const structured = resolveStructuredWorkerAuthority(
      handle,
      this.getOrchestrationDbIfAvailable?.() ?? null
    )
    if (structured) {
      return structured.identity.processIncarnation
    }
    const live = this.getLivePtyForHandle(handle)
    const record = live?.record ?? this.handles.get(handle)
    const pty =
      live?.pty ??
      (record?.ptyId ? this.ptysById.get(record.ptyId) : this.getRetainedHandlePty(handle))
    if (pty?.incarnationId) {
      return `${pty.ptyId}:${pty.incarnationId}`
    }
    if (!record?.ptyId) {
      return this.getOrchestrationCompatibilitySshTerminal(handle)?.processIncarnation ?? null
    }
    // Why: legacy providers may omit process incarnation; retain the prior restart-degraded fence.
    return `${this.runtimeId}:${record.ptyId}:${record.ptyGeneration}`
  }

  getExactWorkerProviderSession(
    handle: string,
    observedAfter: number
  ): ExactWorkerProviderSession | null {
    const paneKey = this.getTerminalPaneKey(handle)
    const processIncarnation = this.getTerminalProcessIncarnation(handle)
    if (!paneKey || !processIncarnation) {
      return null
    }
    let connectionId: string | null | undefined
    let launchToken: string | null | undefined
    let wslDistro: string | undefined
    try {
      const ptyId = this.getTerminalAgentStatusPtyId(handle)
      const pty = this.ptysById.get(ptyId)
      connectionId = pty?.connectionId ?? null
      launchToken = pty?.launchToken ?? null
      // A WSL pane's PTY is local, so its hook events only match once the distro is supplied.
      wslDistro = pty?.connectionId
        ? undefined
        : (this.wslDistroByPtyId.get(ptyId) ?? pty?.wslDistro ?? undefined)
    } catch {
      // Exact worker validation rejects this in production; test/legacy providers may not expose PTY metadata.
    }
    return selectExactWorkerProviderSession({
      paneKey,
      processIncarnation,
      connectionId,
      launchToken,
      wslDistro,
      observedAfter,
      statuses: this.getAgentStatusSnapshotFn?.() ?? []
    })
  }
}
