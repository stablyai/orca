import type { AgentStatus } from '../../shared/agent-detection'
import type { RuntimeTerminalReadiness } from '../../shared/runtime-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { detectKnownReadyPromptAgent } from './terminal-wait-detection'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { RuntimeScreenCapture } from './orca-runtime-core'
import {
  observeTuiIdle,
  captureTuiIdleEvidenceCursor,
  type FirstPartyAgentStatus,
  type TuiIdleEvidenceCursor,
  type TuiIdleObservation
} from './tui-idle-evidence'

type RuntimeTerminalWaitEvidenceDependencies = {
  getAdoptedPtyIdleStatus(pty: RuntimePtyWorktreeRecord): AgentStatus | null
  getAdoptedPtyTitle?(pty: RuntimePtyWorktreeRecord): string | null
  getTabTitle(tabId: string): string | null
  getPaneAgent(ptyId: string | null | undefined): TuiAgent | null
  getFirstPartyAgentStatus(ptyId: string | null | undefined): FirstPartyAgentStatus
  getAttachmentId?(ptyId: string | null | undefined): string | null
  getScreenCapture?(ptyId: string | null | undefined): RuntimeScreenCapture | null
}

export class RuntimeTerminalWaitEvidence {
  constructor(private readonly deps: RuntimeTerminalWaitEvidenceDependencies) {}

  result(observation: TuiIdleObservation): RuntimeTerminalReadiness {
    return {
      state: observation.state,
      source: observation.source,
      ...(observation.agent ? { agent: observation.agent } : {})
    }
  }

  observePty(
    pty: RuntimePtyWorktreeRecord,
    waitText: string,
    evidenceCursor?: TuiIdleEvidenceCursor
  ): TuiIdleObservation {
    const promptAgent = detectKnownReadyPromptAgent(waitText)
    const adoptedIdle = this.deps.getAdoptedPtyIdleStatus(pty) === 'idle'
    const adoptedTitle = this.deps.getAdoptedPtyTitle?.(pty) ?? null
    return observeTuiIdle({
      record: {
        ...pty,
        lastOscTitleObservedAt: pty.lastOscTitleEpochMs,
        attachmentId: this.deps.getAttachmentId?.(pty.ptyId) ?? pty.incarnationId,
        screenCapture: this.deps.getScreenCapture?.(pty.ptyId) ?? null
      },
      rendererTitle: adoptedTitle,
      readPositiveBodyEvidence: () => adoptedIdle || promptAgent !== null,
      positiveBodyEvidenceAgent: promptAgent,
      positiveBodyEvidenceSource: adoptedIdle ? 'title' : 'screen',
      agent: this.deps.getPaneAgent(pty.ptyId),
      firstPartyStatus: this.deps.getFirstPartyAgentStatus(pty.ptyId),
      evidenceCursor
    })
  }

  observeLeaf(
    leaf: RuntimeLeafRecord,
    waitText: string,
    evidenceCursor?: TuiIdleEvidenceCursor
  ): TuiIdleObservation {
    const promptAgent = detectKnownReadyPromptAgent(waitText)
    return observeTuiIdle({
      record: {
        ...leaf,
        attachmentId: this.deps.getAttachmentId?.(leaf.ptyId) ?? null,
        screenCapture: this.deps.getScreenCapture?.(leaf.ptyId) ?? null
      },
      rendererTitle: leaf.paneTitle ?? this.deps.getTabTitle(leaf.tabId),
      readPositiveBodyEvidence: () => promptAgent !== null,
      positiveBodyEvidenceAgent: promptAgent,
      agent: this.deps.getPaneAgent(leaf.ptyId),
      firstPartyStatus: this.deps.getFirstPartyAgentStatus(leaf.ptyId),
      evidenceCursor
    })
  }

  capturePty(pty: RuntimePtyWorktreeRecord): TuiIdleEvidenceCursor {
    return captureTuiIdleEvidenceCursor(
      {
        ...pty,
        lastOscTitleObservedAt: pty.lastOscTitleEpochMs,
        attachmentId: this.deps.getAttachmentId?.(pty.ptyId) ?? pty.incarnationId,
        screenCapture: this.deps.getScreenCapture?.(pty.ptyId) ?? null
      },
      this.deps.getAttachmentId?.(pty.ptyId) ?? pty.incarnationId
    )
  }

  captureLeaf(leaf: RuntimeLeafRecord): TuiIdleEvidenceCursor {
    return captureTuiIdleEvidenceCursor(
      {
        ...leaf,
        attachmentId: this.deps.getAttachmentId?.(leaf.ptyId) ?? null,
        screenCapture: this.deps.getScreenCapture?.(leaf.ptyId) ?? null
      },
      this.deps.getAttachmentId?.(leaf.ptyId) ?? null
    )
  }

  isPtySatisfied(
    pty: RuntimePtyWorktreeRecord,
    waitText: string,
    evidenceCursor?: TuiIdleEvidenceCursor
  ): boolean {
    return this.observePty(pty, waitText, evidenceCursor).state === 'ready'
  }

  isLeafSatisfied(
    leaf: RuntimeLeafRecord,
    waitText: string,
    evidenceCursor?: TuiIdleEvidenceCursor
  ): boolean {
    return this.observeLeaf(leaf, waitText, evidenceCursor).state === 'ready'
  }
}
