import { randomUUID } from 'node:crypto'
import { OrcaRuntimeWithAdmitWindowPublisher } from './session-window-publisher'
import {
  isTerminalLeafId,
  makePaneKey,
  parsePaneKey
} from '../../../shared/workspace-layout/stable-pane-id'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { agentProviderSessionsEqual } from '../../../shared/agent-session/lifecycle/resume/agent-provider-session-equality'
import { mailWakeObligation } from '../orchestration/mailbox/routing/mail-wake-obligation'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../terminal/records/runtime-terminal-state-records'

/** An Agent-slept pane keeps its handle while it has no process, so its resume answers to the same name. */
export abstract class OrcaRuntimeWithSleptLeafHandles extends OrcaRuntimeWithAdmitWindowPublisher {
  protected abstract sleepingMailRecord(paneKey: string): SleepingAgentSessionRecord | null
  protected abstract watchSleepingMail(): void
  protected abstract continueHandleLineCursors(handle: string, ptyId: string): void
  /** Processes the user's own Workspace Sleep stopped, known at the stop, before its records persist. */
  private readonly workspaceSleepPtyIds = new Set<string>()

  protected noteWorkspaceSleepStops(ptyIds: Iterable<string>): void {
    for (const ptyId of ptyIds) {
      this.workspaceSleepPtyIds.add(ptyId)
    }
    // Bounded: only the newest stops matter; an older one has long since persisted its manual record.
    for (const ptyId of this.workspaceSleepPtyIds) {
      if (this.workspaceSleepPtyIds.size <= 1024) {
        break
      }
      this.workspaceSleepPtyIds.delete(ptyId)
    }
  }

  /** Graph sync rebinds handles; waits on a woken slept pane re-check here. */
  protected onSleptLeafGraphSynced(): void {}

  /** A slept pane moved to another tab keeps its name: same leaf id, still without a process. */
  protected carrySleptLeafHandle(
    oldLeafKey: string,
    nextLeaves: ReadonlyMap<string, RuntimeLeafRecord>
  ): boolean {
    const handle = this.handleByLeafKey.get(oldLeafKey)
    const record = handle ? this.handles.get(handle) : undefined
    if (!handle || !record?.ptyId || this.ptysById.get(record.ptyId)?.connected === true) {
      return false
    }
    for (const [leafKey, leaf] of processlessLeavesById(nextLeaves).get(record.leafId) ?? []) {
      if (
        leafKey !== oldLeafKey &&
        this.isAgentSleepStop(makePaneKey(leaf.tabId, leaf.leafId), record.ptyId)
      ) {
        this.terminalIdentity.unbindLeaf(oldLeafKey)
        this.terminalIdentity.setHandle(handle, {
          ...record,
          tabId: leaf.tabId,
          worktreeId: leaf.worktreeId
        })
        this.terminalIdentity.bindLeaf(leafKey, handle)
        return true
      }
    }
    return false
  }

  /** Closed panes already dropped their slept handles; waits on a woken slept pane re-check. */
  protected pruneSleptLeafHandles(): void {
    this.onSleptLeafGraphSynced()
  }

  /** Main's hook row names the exact process Agent Sleep stopped in this pane. */
  protected isAgentSleepStop(paneKey: string, ptyId: string): boolean {
    return this.agentSleepStopPtyId(paneKey) === ptyId
  }

  private agentSleepStopPtyId(paneKey: string): string | null {
    return this.agentSleepStopRow(paneKey)?.paneSleep?.ptyId ?? null
  }

  private agentSleepStopRow(paneKey: string) {
    // Only the newest row speaks for the pane: a resumed agent's own rows supersede the sleep's.
    const rows = this.getAgentStatusSnapshotForPaneFn?.(paneKey) ?? []
    const latest = rows.reduce<(typeof rows)[number] | null>(
      (newest, row) => (!newest || row.receivedAt > newest.receivedAt ? row : newest),
      null
    )
    return latest?.paneSleep ? latest : null
  }

  /** A pane's new process keeps the handle when it is the pane's first (mobile already subscribed
   *  to it), or when Agent Sleep stopped the previous one: the handle stays on the stopped process
   *  (its output and identity still answer for the idle agent) until the resume takes it over. */
  protected retainLeafHandle(
    leaf: Pick<RuntimeLeafRecord, 'tabId' | 'leafId' | 'tailLinesTotal'>,
    previousPtyId: string | null,
    ptyId: string | null,
    ptyGeneration: number
  ): boolean {
    const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
    const handle = this.handleByLeafKey.get(leafKey)
    const sleptPtyId = handle ? this.sleptBoundPtyId(leaf, handle, previousPtyId) : null
    if (sleptPtyId) {
      return ptyId === null || ptyId === sleptPtyId
        ? true
        : this.rebindSleptLeafHandle(leaf, ptyId, ptyGeneration)
    }
    return previousPtyId === null && this.adoptFirstPtyForLeafHandle(leafKey, ptyId, ptyGeneration)
  }

  /** The disconnected process Agent Sleep stopped that this pane's handle still names. A handle
   *  stays on a stopped process under a processless pane only because it slept, so the resume's own
   *  status row, which can supersede the sleep's before the graph shows the resume, keeps it slept. */
  private sleptBoundPtyId(
    leaf: Pick<RuntimeLeafRecord, 'tabId' | 'leafId'>,
    handle: string,
    leafPtyId: string | null
  ) {
    const ptyId = this.handles.get(handle)?.ptyId
    return ptyId &&
      isTerminalLeafId(leaf.leafId) &&
      this.ptysById.get(ptyId)?.connected !== true &&
      (leafPtyId === null || this.isAgentSleepStop(makePaneKey(leaf.tabId, leaf.leafId), ptyId))
      ? ptyId
      : null
  }

  /** A slept pane's handle names its stopped process while the pane shows none: the pane's own, not stale. */
  protected isSleptLeafBinding(handle: string, leaf: RuntimeLeafRecord): boolean {
    return (
      leaf.ptyId === null &&
      this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId)) === handle &&
      this.sleptBoundPtyId(leaf, handle, null) !== null
    )
  }

  /** The resume takes over the slept handle: the stopped process's aliases go, the name moves on. */
  private rebindSleptLeafHandle(
    leaf: Pick<RuntimeLeafRecord, 'tabId' | 'leafId' | 'tailLinesTotal'>,
    ptyId: string,
    ptyGeneration: number
  ): boolean {
    const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
    const handle = this.handleByLeafKey.get(leafKey)
    const record = handle ? this.handles.get(handle) : null
    if (!handle || !record?.ptyId) {
      return false
    }
    // Usually counted when the spawn took the handle; the graph's copy follows the resumed count.
    this.continueHandleLineCursors(handle, ptyId)
    leaf.tailLinesTotal = this.ptysById.get(ptyId)?.tailLinesTotal ?? leaf.tailLinesTotal
    if (this.handleByPtyId.get(record.ptyId) === handle) {
      this.terminalIdentity.unbindPty(record.ptyId)
    }
    if (this.handleByPtyIncarnation.get(record.ptyId)?.handle === handle) {
      this.terminalIdentity.removeIncarnation(record.ptyId)
    }
    this.terminalIdentity.setHandle(handle, { ...record, ptyId: null })
    return this.adoptFirstPtyForLeafHandle(leafKey, ptyId, ptyGeneration)
  }

  /** The handle a slept pane answers to: still bound to the exact process Agent Sleep stopped.
   *  Null when the pane runs a process or never slept. */
  protected sleptLeafHandle(leaf: RuntimeLeafRecord): string | null {
    if (!isTerminalLeafId(leaf.leafId)) {
      return null
    }
    const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
    const handle = this.handleByLeafKey.get(leafKey)
    const sleptPtyId = handle ? this.sleptBoundPtyId(leaf, handle, leaf.ptyId) : null
    if (handle && sleptPtyId && (leaf.ptyId === null || leaf.ptyId === sleptPtyId)) {
      return handle
    }
    return this.restoreSleptLeafHandle(leaf, leafKey, makePaneKey(leaf.tabId, leaf.leafId))
  }

  /** A restart or renderer reload drops the slept handle; main's kept sleep row still marks the pane.
   *  The handle saved on its sleep record is reused so mail and worker-list still name it. */
  private restoreSleptLeafHandle(
    leaf: RuntimeLeafRecord,
    leafKey: string,
    paneKey: string
  ): string | null {
    const current = this.handleByLeafKey.get(leafKey)
    const currentPtyId = current ? this.handles.get(current)?.ptyId : null
    // The graph can lag the pane: a woken process already named is never reminted.
    if (currentPtyId && this.ptysById.get(currentPtyId)?.connected === true) {
      return null
    }
    const sleepRow = this.agentSleepStopRow(paneKey)
    const sleptPtyId = sleepRow?.paneSleep?.ptyId
    if (
      !sleptPtyId ||
      (leaf.ptyId !== null && leaf.ptyId !== sleptPtyId) ||
      this.ptysById.get(sleptPtyId)?.connected === true
    ) {
      return null
    }
    const handle =
      [
        sleepRow && this.recordedSleptHandle(paneKey, sleepRow),
        this.dispatchedSleptHandle(paneKey, sleepRow?.paneSleep)
      ].find((kept) => kept && !this.handles.has(kept)) ?? `term_${randomUUID()}`
    this.terminalIdentity.addSynthetic(handle)
    this.terminalIdentity.setHandle(handle, {
      handle,
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      worktreeId: leaf.worktreeId,
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      ptyId: sleptPtyId,
      ptyGeneration: leaf.ptyGeneration
    })
    this.terminalIdentity.bindLeaf(leafKey, handle)
    return handle
  }

  /** The handle saved on the pane's sleep record, only for the conversation the sleep row stopped. */
  private recordedSleptHandle(
    paneKey: string,
    row: Pick<AgentStatusIpcPayload, 'agentType' | 'providerSession'>
  ): string | undefined {
    const record = this.sleepingMailRecord(paneKey)
    const sameConversation =
      !!record &&
      (row.agentType === undefined || row.agentType === record.agent) &&
      (!row.providerSession ||
        agentProviderSessionsEqual(record.agent, row.providerSession, record.providerSession))
    return sameConversation ? record.terminalHandle : undefined
  }

  /** Records the sleep kept before they carried a handle: the pane's Dispatch handle, only when that
   *  Dispatch's recorded process is the exact one Agent Sleep stopped (an older conversation's is not). */
  private dispatchedSleptHandle(
    paneKey: string,
    stopped: { ptyId: string; incarnationId?: string } | undefined
  ): string | undefined {
    const dispatch = this._orchestrationDb?.getLatestDispatchForTerminal('', paneKey)
    return stopped?.incarnationId &&
      dispatch?.process_incarnation === `${stopped.ptyId}:${stopped.incarnationId}`
      ? (dispatch.assignee_handle ?? undefined)
      : undefined
  }

  /** The slept handle when its pane answers as an idle agent; the user's own Workspace Sleep keeps
   *  the name for its resume but leaves the pane disconnected. */
  private sleptAgentLeafHandle(leaf: RuntimeLeafRecord): string | null {
    const handle = this.sleptLeafHandle(leaf)
    if (!handle) {
      return null
    }
    const stopped = this.handles.get(handle)?.ptyId
    if (stopped && this.workspaceSleepPtyIds.has(stopped)) {
      return null
    }
    this.watchSleepingMail()
    const record = this.sleepingMailRecord(makePaneKey(leaf.tabId, leaf.leafId))
    return mailWakeObligation(record) === 'manual' ? null : handle
  }

  protected isSleptAgentLeaf(leaf: RuntimeLeafRecord): boolean {
    return this.sleptAgentLeafHandle(leaf) !== null
  }

  /** The handle a spawn into this slept pane takes, so its process exports the pane's old name. */
  sleptPaneHandleForSpawn(paneKey: string | null | undefined): string | null {
    const pane = paneKey ? parsePaneKey(paneKey) : null
    const leaf = pane ? this.leaves.get(this.getLeafKey(pane.tabId, pane.leafId)) : undefined
    return leaf ? this.sleptLeafHandle(leaf) : null
  }

  /** A slept agent's handle and its stopped process, whose kept output stands for the idle agent. */
  protected sleptAgentHandle(
    handle: string
  ): { pty: RuntimePtyWorktreeRecord | null; leaf: RuntimeLeafRecord } | null {
    const record = this.handles.get(handle)
    const leaf = record ? this.leaves.get(this.getLeafKey(record.tabId, record.leafId)) : undefined
    if (!record || !leaf || this.sleptAgentLeafHandle(leaf) !== handle) {
      return null
    }
    return { pty: (record.ptyId && this.ptysById.get(record.ptyId)) || null, leaf }
  }
}

const processlessLeafIndexes = new WeakMap<
  ReadonlyMap<string, RuntimeLeafRecord>,
  Map<string, [string, RuntimeLeafRecord][]>
>()

/** One pass per graph: each removed slept pane finds its moved leaf by id, not by scanning the graph. */
function processlessLeavesById(
  leaves: ReadonlyMap<string, RuntimeLeafRecord>
): Map<string, [string, RuntimeLeafRecord][]> {
  let index = processlessLeafIndexes.get(leaves)
  if (!index) {
    index = new Map()
    for (const [leafKey, leaf] of leaves) {
      if (leaf.ptyId === null) {
        index.set(leaf.leafId, [...(index.get(leaf.leafId) ?? []), [leafKey, leaf]])
      }
    }
    processlessLeafIndexes.set(leaves, index)
  }
  return index
}
