import type { RuntimeSyncWindowGraph } from '../../../shared/runtime-session-contracts'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'

export function runtimeGraphLeaf(
  leaf: RuntimeSyncWindowGraph['leaves'][number],
  existing: RuntimeLeafRecord | undefined,
  ptyId: string | null,
  ptyGeneration: number,
  connected: boolean,
  graphStatus: string,
  tailSource: Partial<RuntimeLeafRecord | RuntimePtyWorktreeRecord> | undefined,
  graphSyncedAt: number
): RuntimeLeafRecord {
  return {
    ...leaf,
    ptyId,
    ptyGeneration,
    connected,
    writable: graphStatus === 'ready' && connected,
    lastOutputAt: tailSource?.lastOutputAt ?? null,
    lastExitCode: tailSource?.lastExitCode ?? null,
    lastExitCause: tailSource?.lastExitCause ?? null,
    tailBuffer: tailSource?.tailBuffer ?? [],
    tailTranscriptBuffer: tailSource?.tailTranscriptBuffer ?? [],
    tailTranscriptChars: tailSource?.tailTranscriptChars ?? 0,
    tailPartialLine: tailSource?.tailPartialLine ?? '',
    tailPendingAnsi: tailSource?.tailPendingAnsi ?? '',
    tailRedrawCursor: tailSource?.tailRedrawCursor ?? null,
    tailTruncated: tailSource?.tailTruncated ?? false,
    tailLinesTotal: tailSource?.tailLinesTotal ?? 0,
    preview: tailSource?.preview ?? '',
    waitBlockedAt: tailSource?.waitBlockedAt ?? null,
    lastAgentStatus: tailSource?.lastAgentStatus ?? null,
    lastAgentStatusObservedLive: tailSource?.lastAgentStatusObservedLive ?? false,
    lastOscTitle: tailSource?.lastOscTitle ?? null,
    lastOscTitleAt: tailSource?.lastOscTitleAt ?? null,
    paneTitleUpdatedAt:
      existing?.ptyId === ptyId && existing.paneTitle === leaf.paneTitle
        ? existing.paneTitleUpdatedAt
        : graphSyncedAt
  }
}
