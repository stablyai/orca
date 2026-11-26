import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { RuntimeLeafRecord } from '../../../terminal/records/runtime-terminal-state-records'

const leavesByRecord = new WeakMap<SleepingAgentSessionRecord, RuntimeLeafRecord>()
const handlesByLeaf = new WeakMap<RuntimeLeafRecord, string>()

/** The handle a slept agent's unmounted pane answers to; undefined for every graph pane. */
export function unmountedSleptLeafHandle(leaf: RuntimeLeafRecord): string | undefined {
  return handlesByLeaf.get(leaf)
}

/** The pane a slept agent's saved record names while its tab isn't mounted: no process, no output
 *  kept here, one per record so repeated reads of the same sleep share it. */
export function unmountedSleptLeaf(
  record: SleepingAgentSessionRecord,
  pane: { tabId: string; leafId: string }
): RuntimeLeafRecord {
  let leaf = leavesByRecord.get(record)
  if (!leaf) {
    leaf = {
      tabId: pane.tabId,
      worktreeId: record.worktreeId,
      leafId: pane.leafId,
      paneRuntimeId: -1,
      ptyId: null,
      title: record.terminalTitle ?? null,
      ptyGeneration: 0,
      connected: false,
      writable: false,
      lastOutputAt: null,
      lastExitCode: null,
      lastExitCause: null,
      lastAgentStatus: null,
      lastAgentStatusObservedLive: false,
      lastOscTitle: null,
      lastOscTitleAt: null,
      paneTitleUpdatedAt: null,
      tailBuffer: [],
      tailTranscriptBuffer: [],
      tailTranscriptChars: 0,
      tailPartialLine: '',
      tailPendingAnsi: '',
      tailRedrawCursor: null,
      tailTruncated: false,
      tailLinesTotal: 0,
      preview: '',
      waitBlockedAt: null
    }
    leavesByRecord.set(record, leaf)
    if (record.terminalHandle) {
      handlesByLeaf.set(leaf, record.terminalHandle)
    }
  }
  return leaf
}
