import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status-types'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { OrcaRuntimeWithVerifyOrchestrationCompatibilityCaller } from '../../orchestration/terminal-authority/verify-orchestration-compatibility-caller'
import type { OrchestrationCompatibilityTerminalAuthority } from '../../runtime-terminal-contracts'
import { createHash } from 'node:crypto'
import {
  isTerminalLeafId,
  makePaneKey,
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import { RecentPtyOutputBuffer } from '../../recent-pty-output-buffer'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import { resolveLocalProjectRuntimeForWorktreeId } from '../../../local-project-runtime-resolution'
import type { AgentDetectionHost } from '../../../preflight/workspace-agent-detection'
import { resolveRuntimeAgentDetectionHost } from '../../runtime-agent-detection-host'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import {
  localOrchestrationCliCommand,
  resolveTerminalOrchestrationCliCommand,
  runtimeOrchestrationCliCommand
} from '../../orchestration/cli-command'
import { readOrchestrationFleetAgentStatusSnapshot } from '../../orchestration-fleet-agent-status-snapshot'
import { resolveStructuredWorkerAuthority } from '../../structured-worker-authority'
import { isStructuredWorkerHandle } from '../../../../shared/structured-worker-handle'
import { parseOrcaSessionAddress } from '../../../../shared/orca-session-address'
import { matchesProcessIncarnation } from '../../orchestration/worker-terminal-process-liveness'

export abstract class OrcaRuntimeWithGetOrchestrationDispatchAuthority extends OrcaRuntimeWithVerifyOrchestrationCompatibilityCaller {
  protected abstract getExistingTerminalHandlesForPtyId(ptyId: string): string[]
  protected abstract getOrchestrationDbIfAvailable(): OrchestrationDb | null
  abstract getTerminalProcessIncarnation(handle: string): string | null
  abstract getAgentStatusOrchestrationContextForPaneKey(
    paneKey: string
  ): AgentStatusOrchestrationContext | undefined
  protected abstract issuePtyHandle(pty: RuntimePtyWorktreeRecord): string

  /** Every pane key this PTY could be addressed by, including restored receipts. */
  protected collectPaneKeysForPty(ptyId: string): Set<string> {
    const paneKeys = new Set<string>()
    const ptyPaneKey = this.paneOfPty(this.ptysById.get(ptyId)).paneKey
    if (ptyPaneKey && parsePaneKey(ptyPaneKey)) {
      paneKeys.add(ptyPaneKey)
    }
    const receipt = this.restoredOrchestrationAuthorityByPtyId.get(ptyId)
    if (receipt?.paneKey && parsePaneKey(receipt.paneKey)) {
      paneKeys.add(receipt.paneKey)
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      if (isValidTerminalTabId(leaf.tabId) && isTerminalLeafId(leaf.leafId)) {
        paneKeys.add(makePaneKey(leaf.tabId, leaf.leafId))
      }
    }
    return paneKeys
  }

  /** Status cleanup also owns runtime-admitted legacy OSC rows; orchestration authority does not. */
  protected collectAgentStatusPaneKeysForPty(ptyId: string): Set<string> {
    const paneKeys = this.collectPaneKeysForPty(ptyId)
    const terminalHandles = new Set(this.getExistingTerminalHandlesForPtyId(ptyId))
    // The provider-session snapshot is the unfiltered store view, so certified exit can also
    // retire a dismissed row's identity-only remnant after its pane binding moved.
    for (const row of this.getAgentProviderSessionSnapshotFn?.() ?? []) {
      if (row.terminalHandle && terminalHandles.has(row.terminalHandle)) {
        paneKeys.add(row.paneKey)
      }
    }
    const ptyPaneKey = this.paneOfPty(this.ptysById.get(ptyId)).paneKey
    if (ptyPaneKey && parseLegacyNumericPaneKey(ptyPaneKey)) {
      paneKeys.add(ptyPaneKey)
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      const paneKey = this.makeRuntimePaneKey(leaf)
      if (parseLegacyNumericPaneKey(paneKey)) {
        paneKeys.add(paneKey)
      }
    }
    return paneKeys
  }

  getOrchestrationDispatchAuthority(
    terminalHandle: string
  ): OrchestrationCompatibilityTerminalAuthority | null {
    const structured = resolveStructuredWorkerAuthority(
      terminalHandle,
      this.getOrchestrationDbIfAvailable?.() ?? null
    )
    if (structured) {
      return {
        runtimeId: this.runtimeId,
        terminalHandle,
        // Empty PTY/token prevent restored-receipt fallback from granting hook attestation to a structured session with no PTY or launch secret.
        ptyId: '',
        worktreeId: structured.identity.worktreeId,
        processIncarnation: structured.identity.processIncarnation,
        paneKey: structured.identity.paneKey,
        launchTokenHash: null,
        hostScope: structured.identity.hostScope
      }
    }
    let ptyId: string | null
    try {
      ptyId =
        this.getLivePtyForHandle(terminalHandle)?.pty.ptyId ??
        this.resolveLiveLeafForHandle(terminalHandle)?.ptyId ??
        null
    } catch {
      return null
    }
    if (!ptyId) {
      return null
    }
    const pty = this.ptysById.get(ptyId)
    if (!pty?.connected) {
      return null
    }
    const hostScope = this.getOrchestrationCompatibilityHostScope(pty)
    if (!hostScope) {
      return null
    }
    return {
      runtimeId: this.runtimeId,
      terminalHandle,
      ptyId,
      worktreeId: pty.worktreeId,
      processIncarnation: this.getTerminalProcessIncarnation(terminalHandle),
      paneKey: this.paneOfPty(pty).paneKey,
      launchTokenHash: pty.launchToken
        ? createHash('sha256').update(pty.launchToken).digest('hex')
        : null,
      hostScope
    }
  }

  protected retirePtyAgentLaunchAuthority(ptyId: string): void {
    const pty = this.ptysById.get(ptyId)
    if (!pty) {
      return
    }
    const receipt = this.restoredOrchestrationAuthorityByPtyId.get(ptyId)
    if (!pty.launchToken && !receipt && !pty.launchAgent && !pty.launchCommandAgent) {
      return
    }
    // Why: collect before the delete below, which drops the restored-authority receipt a
    // receipt-only pane's key comes from.
    const paneKeys = this.collectPaneKeysForPty(ptyId)
    this.restoredOrchestrationAuthorityByPtyId.delete(ptyId)
    pty.launchToken = null
    pty.launchIncarnationId = null
    pty.launchAgent = null
    pty.launchCommandAgent = null
    for (const paneKey of paneKeys) {
      this.retireAgentHookCompatibilityAuthorityFn?.(paneKey)
    }
  }

  async resolveTerminalCwd(handle: string): Promise<string | null> {
    const ptyId = this.resolveLeafForHandle(handle)?.ptyId
    if (!ptyId) {
      return null
    }
    const tracked = this.terminalCwdByPtyId.get(ptyId)
    if (tracked) {
      return tracked
    }
    try {
      const cwd = await this.ptyController?.getCwd?.(ptyId)
      return cwd && cwd.trim().length > 0 ? cwd : null
    } catch {
      return null
    }
  }

  resolveTerminalFileUriHostname(handle: string): string | null {
    const ptyId = this.resolveLeafForHandle(handle)?.ptyId
    return ptyId ? (this.terminalFileUriHostnameByPtyId.get(ptyId) ?? null) : null
  }

  protected recordRecentPtyOutput(ptyId: string, data: string): void {
    let recentOutputBuffer = this.recentPtyOutputById.get(ptyId)
    if (!recentOutputBuffer) {
      recentOutputBuffer = new RecentPtyOutputBuffer()
      this.recentPtyOutputById.set(ptyId, recentOutputBuffer)
    }
    recentOutputBuffer.append(data)
  }

  // Why: remote clients cannot resolve this runtime's WSL project preference,
  // so host-affecting RPCs (skill discovery) resolve it from the owning store.
  resolveProjectRuntimeForWorktree(
    worktreeId: string | null | undefined
  ): ProjectExecutionRuntimeResolution | undefined {
    return this.store && worktreeId
      ? resolveLocalProjectRuntimeForWorktreeId(this.requireStore(), worktreeId)
      : undefined
  }

  async resolveAgentDetectionHost(
    worktreeId: string | null | undefined,
    repoId?: string
  ): Promise<AgentDetectionHost> {
    return resolveRuntimeAgentDetectionHost(
      {
        store: this.store,
        resolveRepo: (selector) => this.resolveRepoSelector(selector),
        resolveWorktree: (selector) => this.resolveWorktreeSelector(selector)
      },
      worktreeId,
      repoId
    )
  }

  getOrchestrationFleetAgentStatusSnapshot() {
    return readOrchestrationFleetAgentStatusSnapshot(this)
  }

  getTerminalOrchestrationCliCommand(handle: string) {
    // A structured session runs in this process: it is told what the structured mail lane types.
    if (isStructuredWorkerHandle(handle) || parseOrcaSessionAddress(handle)) {
      return localOrchestrationCliCommand()
    }
    let pty: RuntimePtyWorktreeRecord | null = null
    try {
      const ptyId = this.resolveLeafForHandle(handle)?.ptyId
      pty = ptyId ? (this.ptysById.get(ptyId) ?? null) : null
    } catch {
      return 'orca'
    }
    if (!pty) {
      return 'orca'
    }
    return resolveTerminalOrchestrationCliCommand({
      connectionId: pty.connectionId,
      isWsl: pty.isWsl,
      worktreeId: pty.worktreeId,
      runtimeCliCommand: runtimeOrchestrationCliCommand(),
      projectRuntime: this.store
        ? resolveLocalProjectRuntimeForWorktreeId(this.requireStore(), pty.worktreeId)
        : undefined
    })
  }
  /** Recover a handle only for an exact live process incarnation and known host scope; never close a replacement under a reused PTY id. workerShow also uses this without lease rechecks. */
  resolveTerminalHandleByProcessIncarnation(
    processIncarnation: string,
    serializedHostScope: string | null
  ): string | null {
    if (!processIncarnation || !serializedHostScope) {
      return null
    }
    // Match the complete incarnation rather than splitting colons: PTY/incarnation ids may contain them, and missing-incarnation legacy ids stay fail-closed.
    for (const [ptyId, pty] of this.ptysById) {
      if (!matchesProcessIncarnation(ptyId, pty.incarnationId, processIncarnation)) {
        continue
      }
      const hostScope = this.getOrchestrationCompatibilityHostScope(pty)
      if (!hostScope || JSON.stringify(hostScope) !== serializedHostScope) {
        // A colon-ambiguous foreign-host decoy must not hide a later genuine same-scope match.
        continue
      }
      return this.issuePtyHandle(pty)
    }
    return null
  }
}
