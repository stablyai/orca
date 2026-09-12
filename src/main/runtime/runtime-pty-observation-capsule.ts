import { createAgentStatusOscProcessor } from '../../shared/agent-status-osc'
import type { ProcessedAgentStatusChunk } from '../../shared/agent-status-osc'
import { detectAgentStatusFromTitle } from '../../shared/agent-detection'
import { createTerminalTitleTracker } from '../../shared/terminal-output-side-effects'
import type {
  TerminalTitleFactMeta,
  TerminalTitleTrackerCallbacks
} from '../../shared/terminal-output-side-effects'
import { extractLastOsc7Uri, extractOscScanTail } from '../daemon/osc7-uri-extraction'
import { extractOscTitleScanTail } from '../../shared/osc-title-scan-tail'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { PtyTransientFact } from '../providers/types'
import type { RuntimePtyTitleTrackerEntry } from './runtime-terminal-state-records'
import {
  createPendingPtyObservationSummary,
  recordPtyObservationCwd,
  recordPtyObservationExplicitStatus,
  recordPtyObservationLifecycle,
  recordPtyObservationTitle,
  type PendingPtyObservationSummary,
  type PtyObservationSource,
  type PtyObservationStamp
} from './runtime-pty-observation-admission'

const OSC7_SCAN_TAIL_CODE_UNITS = 4096

/** One unadmitted source's private parser state plus its compact reduced evidence. */
export type RuntimePtyObservationCapsule = {
  source: PtyObservationSource
  entry: RuntimePtyTitleTrackerEntry
  agentStatusProcessor: (data: string) => ProcessedAgentStatusChunk
  oscTitleScanTail: string
  osc7ScanTail: string
  summary: PendingPtyObservationSummary
  /** Set at promotion: the tracker stops reducing and drives the live PTY again. */
  admittedLiveCallbacks: TerminalTitleTrackerCallbacks | null
}

/** One in-flight spawn's claim on a PTY id's candidate capsules. */
export type PendingPtyObservationAdmission = {
  token: string
  ptyId: string
  /** Set when a source beyond the audited retry bound appeared; admission then fails closed. */
  overflowed: boolean
}

/** The single candidate a completed commit may promote, validated at commit entry. */
export type PreparedPtyObservationAdmission = {
  token: string
  ptyId: string
  incarnationId?: PtyIncarnationId
  capsule: RuntimePtyObservationCapsule | null
  /** The pane this commit is binding, when every part of its identity validated. */
  surface?: { worktreeId: string; tabId: string; leafId: string }
  /**
   * The incarnation this pane's durable binding named at commit entry, read before the
   * binding write replaces it. A relaunched host has no live predecessor, so this is its
   * only known-old; absent unless the record names THIS PTY.
   */
  persistedIncarnationId?: PtyIncarnationId
}

/** The runtime-owned decisions a capsule needs without reaching into the runtime. */
export type PtyObservationCapsuleHooks = {
  isIdentityOnlyTitle: (rawTitle: string, meta?: TerminalTitleFactMeta) => boolean
  nextStamp: () => PtyObservationStamp
  resolveOsc7Path: (ptyId: string, uri: string) => string | null
}

export function createRuntimePtyObservationCapsule(
  source: PtyObservationSource,
  hooks: PtyObservationCapsuleHooks
): RuntimePtyObservationCapsule {
  const capsule: RuntimePtyObservationCapsule = {
    source,
    entry: null as unknown as RuntimePtyTitleTrackerEntry,
    agentStatusProcessor: createAgentStatusOscProcessor(),
    oscTitleScanTail: '',
    osc7ScanTail: '',
    summary: createPendingPtyObservationSummary(),
    admittedLiveCallbacks: null
  }
  const live = (): TerminalTitleTrackerCallbacks | null => capsule.admittedLiveCallbacks
  capsule.entry = {
    tracker: createTerminalTitleTracker({
      onTitle: (normalizedTitle, rawTitle, meta) => {
        const admitted = live()
        if (admitted) {
          admitted.onTitle?.(normalizedTitle, rawTitle, meta)
          return
        }
        const identityOnly = hooks.isIdentityOnlyTitle(rawTitle, meta)
        const stamp = hooks.nextStamp()
        if (
          !recordPtyObservationTitle(
            capsule.summary,
            { rawTitle, normalizedTitle, identityOnly },
            stamp
          )
        ) {
          // A refused title leaves no derived status behind. OSC titles arrive
          // elided under the bound, so this is the local invariant, not a live path.
          return
        }
        recordPtyObservationLifecycle(
          capsule.summary,
          {
            kind: 'agent-status',
            status: identityOnly ? null : detectAgentStatusFromTitle(rawTitle)
          },
          stamp
        )
      },
      // An unadmitted candidate never replays attention: bells, working/idle
      // edges, agent exits, PR links and 2031 flips reduce to nothing. Once
      // admitted the same tracker owns the live PTY, so it must delegate.
      onAgentBecameWorking: () => live()?.onAgentBecameWorking?.(),
      onAgentBecameIdle: (title: string, meta?: TerminalTitleFactMeta) =>
        live()?.onAgentBecameIdle?.(title, meta),
      onAgentExited: () => live()?.onAgentExited?.(),
      onCommandFinished: (exitCode: number | null) => {
        const admitted = live()
        if (admitted) {
          admitted.onCommandFinished?.(exitCode)
          return
        }
        recordPtyObservationLifecycle(
          capsule.summary,
          { kind: 'command-finished', exitCode },
          hooks.nextStamp()
        )
      },
      onBell: () => live()?.onBell?.(),
      onPrLink: (link) => live()?.onPrLink?.(link),
      onMode2031Subscribe: () => live()?.onMode2031Subscribe?.(),
      onMode2031Unsubscribe: () => live()?.onMode2031Unsubscribe?.()
    }),
    applyingChunk: false,
    lastMobileTitleGateKey: null,
    lastTitleFactAtMs: null,
    chunkTouchedSessionTabs: false,
    pendingFacts: [],
    // Command Code facts exist only for the pty:sideEffect channel; the detector is armed at promotion.
    commandCodeDetector: null
  }
  return capsule
}

/** Parse one chunk entirely inside the capsule; nothing reaches PTY/leaf records. */
export function observePtyObservationChunk(
  capsule: RuntimePtyObservationCapsule,
  data: string,
  hooks: PtyObservationCapsuleHooks
): void {
  if (capsule.osc7ScanTail.length > 0 || data.includes('\x1b]7;')) {
    const osc7Input = `${capsule.osc7ScanTail}${data}`
    capsule.osc7ScanTail = extractOscScanTail(osc7Input, OSC7_SCAN_TAIL_CODE_UNITS)
    const uri = extractLastOsc7Uri(osc7Input)
    const path = uri ? hooks.resolveOsc7Path(capsule.source.ptyId, uri) : null
    if (path && path.trim().length > 0) {
      recordPtyObservationCwd(capsule.summary, path, hooks.nextStamp())
    }
  }
  const chunk = capsule.agentStatusProcessor(data)
  for (const payload of chunk.payloads) {
    recordPtyObservationExplicitStatus(capsule.summary, payload, hooks.nextStamp())
  }
  const titleInput = `${capsule.oscTitleScanTail}${chunk.cleanData}`
  capsule.oscTitleScanTail = extractOscTitleScanTail(titleInput)
  capsule.entry.applyingChunk = true
  try {
    capsule.entry.tracker.handleChunk(chunk.cleanData, { titleScanData: titleInput })
  } finally {
    capsule.entry.applyingChunk = false
    capsule.entry.pendingFacts = []
  }
}

/** The accepted per-PTY parser slots a promoted capsule takes over. */
export type PtyObservationParserSlots = {
  titleTrackers: Map<string, RuntimePtyTitleTrackerEntry>
  agentStatusProcessors: Map<string, (data: string) => ProcessedAgentStatusChunk>
  oscTitleScanTails: Map<string, string>
  osc7ScanTails: Map<string, string>
}

/** Hand the winning capsule's already-parsed state to the accepted slots, carries included. */
export function installPromotedPtyObservationCapsule(
  ptyId: string,
  capsule: RuntimePtyObservationCapsule,
  slots: PtyObservationParserSlots,
  sideEffects: {
    enabled: boolean
    createCommandCodeDetector: () => RuntimePtyTitleTrackerEntry['commandCodeDetector']
  },
  liveCallbacks: TerminalTitleTrackerCallbacks
): void {
  capsule.entry.commandCodeDetector = sideEffects.enabled
    ? sideEffects.createCommandCodeDetector()
    : null
  capsule.entry.tracker.setTransientSideEffectScanningEnabled(sideEffects.enabled)
  // Stop reducing into the summary: from here the capsule's tracker IS the PTY's live tracker.
  capsule.admittedLiveCallbacks = liveCallbacks
  slots.titleTrackers.set(ptyId, capsule.entry)
  slots.agentStatusProcessors.set(ptyId, capsule.agentStatusProcessor)
  setOrDelete(slots.oscTitleScanTails, ptyId, capsule.oscTitleScanTail)
  setOrDelete(slots.osc7ScanTails, ptyId, capsule.osc7ScanTail)
}

function setOrDelete(carries: Map<string, string>, ptyId: string, carry: string): void {
  if (carry.length > 0) {
    carries.set(ptyId, carry)
  } else {
    carries.delete(ptyId)
  }
}

/** Source-local marker/gap reset: a candidate's discontinuity never resets the accepted parser. */
export function resetPtyObservationParseCarry(capsule: RuntimePtyObservationCapsule): void {
  capsule.oscTitleScanTail = ''
  capsule.osc7ScanTail = ''
  capsule.agentStatusProcessor = createAgentStatusOscProcessor()
}

export function observePtyObservationTransientFact(
  capsule: RuntimePtyObservationCapsule,
  fact: PtyTransientFact,
  hooks: PtyObservationCapsuleHooks
): void {
  if (fact.kind === 'command-finished') {
    recordPtyObservationLifecycle(
      capsule.summary,
      { kind: 'command-finished', exitCode: fact.exitCode },
      hooks.nextStamp()
    )
  }
  // bell / pr-link / 2031 facts are attention or renderer policy: never replayed on promotion.
}
