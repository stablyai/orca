import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess,
  recognizeAgentProcess,
  type RecognizedAgentProcess
} from '../../shared/agent-process-recognition'
import { isOpenCodeNativeTitle } from '../../shared/agent-detection'
import { isShellProcess } from '../../shared/shell-process-detection'
import { isKnownReadyPromptPreview } from './terminal-wait-detection'
import { buildTerminalWaitText } from './terminal-wait-tail-state'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import {
  agentTitleProvesAgentPresence,
  classifyAgentTitle,
  classifyLatestAgentTitle,
  getLatestAgentCandidateTitle,
  getLatestLeafTitle,
  getLeafDisplayRecord,
  getPtyDisplayRecord,
  ptyTitleProvesAgentPresence,
  type TitleDisplayClear
} from './runtime-worktree-status-projection'

const WRAPPER_RETRY_INTERVAL_MS = 150
const WRAPPER_RETRY_TIMEOUT_MS = 6_500

/** `unknown`: nothing shows an agent and the foreground process could not be read. */
export type TerminalAgentPresence = 'present' | 'absent' | 'unknown'

type RuntimeTerminalAgentPresenceDependencies = {
  /** A structured agent session of this runtime; it has no pane, so no PTY probe can see it. */
  isLiveStructuredAgent?(handle: string): boolean
  getLivePty(handle: string): RuntimePtyWorktreeRecord | null
  getLiveLeaf(handle: string): RuntimeLeafRecord
  getPrimaryLeaf(ptyId: string): RuntimeLeafRecord | null
  getTrackedPty(ptyId: string): RuntimePtyWorktreeRecord | null
  getTabTitle(tabId: string): string | null
  getForegroundProcess(ptyId: string): Promise<string | null> | null
  confirmForegroundProcess(ptyId: string): Promise<string | null> | null
  /** The agent's own live account of itself: OSC 7501 activity or a fresh hook status row. */
  reportsAgentStatus(handle: string, ptyId: string): boolean
  /** The stale-working timer's display-only clear of the PTY's own title, if one stands. */
  getTitleDisplayClear(ptyId: string): TitleDisplayClear | null
}

/** `fresh`: a second read answered (a process-tree read; on Windows it may echo the cached name). */
export type ForegroundRead =
  | ({ kind: 'agent' } & RecognizedAgentProcess)
  | { kind: 'shell' | 'wrapper' | 'other'; fresh: boolean }
  | { kind: 'unreadable' }

/** What the pane's records show; `titleOnlyStatus`: a title-derived status with no title over it. */
type PaneRecordEvidence = Omit<PaneAgentEvidence, 'reportsStatus'> & { titleOnlyStatus: boolean }

type PaneAgentEvidence = {
  ptyId: string | null
  /** A title or prompt that only an agent paints. */
  shown: boolean
  /** The agent reported its own status (OSC 7501, a hook row, or a title-only status), not suppressed. */
  reportsStatus: boolean
  /** Claude's management screen is up, so a Claude process there is not a task agent. */
  suppressClaude: boolean
}

export class RuntimeTerminalAgentPresence {
  constructor(private readonly deps: RuntimeTerminalAgentPresenceDependencies) {}

  /** `foreground`: a read the caller already made, so the process is not read twice. */
  async resolve(handle: string, foreground?: ForegroundRead): Promise<TerminalAgentPresence> {
    // Why: a structured session IS the agent and has no pane or foreground process to probe.
    if (this.deps.isLiveStructuredAgent?.(handle)) {
      return 'present'
    }
    try {
      const pane = this.readPaneEvidence(handle)
      if (pane.shown) {
        return 'present'
      }
      if (!pane.ptyId) {
        return pane.reportsStatus ? 'present' : 'absent'
      }
      const read = foreground ?? (await this.readForegroundOnce(pane.ptyId, pane.reportsStatus))
      switch (read.kind) {
        case 'agent':
          return pane.suppressClaude && isExpectedAgentProcess(read.processName, 'claude')
            ? 'absent'
            : 'present'
        case 'wrapper':
          return (await this.waitForWrappedAgent(pane.ptyId, pane.suppressClaude))
            ? 'present'
            : 'absent'
        case 'unreadable':
          return pane.reportsStatus ? 'present' : 'unknown'
        case 'shell':
        case 'other':
          // Why: an agent under OSC 7501 paints no title glyph, so its own status is the evidence
          // wherever the process read cannot name what runs.
          return pane.reportsStatus && !contradictsReportedStatus(read) ? 'present' : 'absent'
      }
    } catch {
      return 'absent'
    }
  }

  /** Whether the foreground proves that a reported agent status is left over. */
  async foregroundContradictsStatus(ptyId: string): Promise<boolean> {
    return contradictsReportedStatus(await this.readForeground(ptyId))
  }

  /**
   * The foreground, re-read once from the launch command line when the cached name proves
   * nothing: macOS p_comm names the native Claude install by its version directory (`2.1.310`),
   * npm installs run as `node`, and a Windows tracker answers with the shell until its scan lands.
   */
  readForeground(ptyId: string): Promise<ForegroundRead> {
    return this.readForegroundOnce(ptyId, true)
  }

  /** `confirmShell` false keeps a plain shell with no status behind it to the cheap cached read. */
  private async readForegroundOnce(ptyId: string, confirmShell: boolean): Promise<ForegroundRead> {
    const cached = await Promise.resolve(this.deps.getForegroundProcess(ptyId)).catch(() => null)
    if (recognizeAgentProcess(cached) || (!confirmShell && cached && isShellProcess(cached))) {
      return classifyForeground(cached, false)
    }
    const fresh = await Promise.resolve(this.deps.confirmForegroundProcess(ptyId)).catch(() => null)
    return fresh ? classifyForeground(fresh, true) : classifyForeground(cached, false)
  }

  private readPaneEvidence(handle: string): PaneAgentEvidence {
    const { titleOnlyStatus, ...pane } = this.readPaneRecords(handle)
    const reportsStatus =
      !pane.suppressClaude &&
      (titleOnlyStatus || (pane.ptyId !== null && this.deps.reportsAgentStatus(handle, pane.ptyId)))
    return { ...pane, reportsStatus }
  }

  private readPaneRecords(handle: string): PaneRecordEvidence {
    // Why display records: presence reads what the pane shows, as before the stale-working
    // clear stopped rewriting records. A cwd spinner clears to a neutral title, so the
    // foreground process decides for an agent that exited behind it.
    const pty = this.deps.getLivePty(handle)
    if (pty) {
      const clear = this.deps.getTitleDisplayClear(pty.ptyId)
      const leaf = this.deps.getPrimaryLeaf(pty.ptyId)
      return readPtyEvidence(
        getPtyDisplayRecord(pty, clear),
        leaf ? getLeafDisplayRecord(leaf, clear) : null
      )
    }
    const liveLeaf = this.deps.getLiveLeaf(handle)
    const leaf = getLeafDisplayRecord(
      liveLeaf,
      liveLeaf.ptyId ? this.deps.getTitleDisplayClear(liveLeaf.ptyId) : null
    )
    const trackedPty = leaf.ptyId ? this.deps.getTrackedPty(leaf.ptyId) : null
    const titleProves = (
      title: string | null,
      classification: ReturnType<typeof classifyAgentTitle>
    ): boolean =>
      trackedPty
        ? ptyTitleProvesAgentPresence(trackedPty, title, classification)
        : agentTitleProvesAgentPresence(title, classification)
    const paneTitle = getLatestLeafTitle(leaf, null)
    const paneClassification = classifyAgentTitle(paneTitle)
    const tabTitle = this.deps.getTabTitle(leaf.tabId)
    const tabClassification = paneTitle === null ? classifyAgentTitle(tabTitle) : 'neutral'
    const waitText = buildTerminalWaitText(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview)
    return {
      ptyId: leaf.ptyId,
      shown:
        titleProves(paneTitle, paneClassification) ||
        titleProves(tabTitle, tabClassification) ||
        (!isOpenCodeNativeTitle(paneTitle ?? tabTitle) && isKnownReadyPromptPreview(waitText)),
      titleOnlyStatus: leaf.lastAgentStatus !== null && paneTitle === null && tabTitle === null,
      suppressClaude: paneClassification === 'management' || tabClassification === 'management'
    }
  }

  private async waitForWrappedAgent(ptyId: string, suppressClaude: boolean): Promise<boolean> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < WRAPPER_RETRY_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, WRAPPER_RETRY_INTERVAL_MS))
      const refreshed = await this.deps.getForegroundProcess(ptyId)
      const recognized = recognizeAgentProcess(refreshed)
      if (recognized) {
        return !(suppressClaude && isExpectedAgentProcess(recognized.processName, 'claude'))
      }
      if (!refreshed || !isAgentForegroundWrapperProcess(refreshed)) {
        return false
      }
    }
    return false
  }
}

function readPtyEvidence(
  pty: RuntimePtyWorktreeRecord,
  leaf: RuntimeLeafRecord | null
): PaneRecordEvidence {
  const leafTitle = leaf
    ? getLatestAgentCandidateTitle(
        { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt },
        { title: leaf.lastOscTitle, updatedAt: leaf.lastOscTitleAt }
      )
    : null
  const leafClassification = classifyAgentTitle(leafTitle)
  const ptyTitle = getLatestAgentCandidateTitle(
    { title: pty.title, updatedAt: pty.titleUpdatedAt },
    { title: pty.lastOscTitle, updatedAt: pty.lastOscTitleAt }
  )
  const markerTitle = leafTitle ?? ptyTitle
  const waitText = buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
  const management =
    classifyLatestAgentTitle({ title: pty.managementTitle, updatedAt: pty.managementTitleAt }) ===
    'management'
  return {
    ptyId: pty.ptyId,
    shown:
      ptyTitleProvesAgentPresence(pty, leafTitle, leafClassification) ||
      (leafTitle === null &&
        ptyTitleProvesAgentPresence(pty, ptyTitle, classifyAgentTitle(ptyTitle))) ||
      (isOpenCodeNativeTitle(markerTitle) && pty.launchAgent === 'opencode') ||
      (!isOpenCodeNativeTitle(markerTitle) && isKnownReadyPromptPreview(waitText)),
    titleOnlyStatus:
      pty.lastAgentStatus !== null && leafTitle === null && ptyTitle === null && !management,
    suppressClaude: leafTitle !== null ? leafClassification === 'management' : management
  }
}

function classifyForeground(processName: string | null, fresh: boolean): ForegroundRead {
  if (!processName) {
    return { kind: 'unreadable' }
  }
  const recognized = recognizeAgentProcess(processName)
  if (recognized) {
    return { kind: 'agent', ...recognized }
  }
  return {
    kind: isShellProcess(processName)
      ? 'shell'
      : isAgentForegroundWrapperProcess(processName)
        ? 'wrapper'
        : 'other',
    fresh
  }
}

/** A shell, or a launch command line that names no agent; an opaque or unread name does not. */
function contradictsReportedStatus(read: ForegroundRead): boolean {
  return (
    read.kind === 'shell' || (read.kind !== 'agent' && read.kind !== 'unreadable' && read.fresh)
  )
}
