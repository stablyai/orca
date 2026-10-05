// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithEmitDaemonPtyTransientFact } from './orca-runtime-emit-daemon-pty-transient-fact'
import { getDecorativeTitleGateKey } from '../../shared/agent-decorative-title-signature'
import { shouldEmitTitleFactForFrame } from './decorative-title-fact-emission'
import type { RuntimePtyTitleTrackerEntry } from './runtime-terminal-state-records'
import { createTerminalTitleTracker } from '../../shared/terminal-output-side-effects'
import { detectAgentStatusFromTitle } from '../../shared/agent-detection'
import type { TerminalGitHubPRLink } from '../../shared/terminal-github-pr-link-detector'

export class OrcaRuntimeWithGetUnpersistedTrackedTitleForPty extends OrcaRuntimeWithEmitDaemonPtyTransientFact {
  protected getUnpersistedTrackedTitleForPty(ptyId: string | null): string | null {
    if (!ptyId || this.getTrackedRawTitleForPty(ptyId) !== null) {
      return null
    }
    // Why: a manual title is authoritative until explicitly cleared with null.
    const pty = this.ptysById.get(ptyId)
    if (pty && pty.title !== null) {
      return null
    }
    return this.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.getLastNormalizedTitle() ?? null
  }

  /** Why: synthetic agent title frames no longer ride pty:data, so neither
   *  renderer xterm nor the headless emulator observes them. Mobile-parity
   *  snapshot titles must prefer main's tracker over snapshot lastTitle, or
   *  hook-driven spinner/idle titles vanish from mobile tabs. */
  protected preferTrackedLastTitle<T extends { lastTitle?: string }>(
    ptyId: string,
    snapshot: T
  ): T {
    const tracked = this.getTrackedDisplayTitleForPty(ptyId)
    if (!tracked) {
      return snapshot
    }
    return { ...snapshot, lastTitle: tracked }
  }

  /** Decorative comparison key: only recognized agent titles fold leading spinner frames. */
  protected makeDecorativeTitleGateKey(rawTitle: string, normalizedTitle: string): string {
    return getDecorativeTitleGateKey(rawTitle, normalizedTitle)
  }

  protected getOrCreatePtyTitleTrackerEntry(ptyId: string): RuntimePtyTitleTrackerEntry {
    const existing = this.ptyTitleTrackersByPtyId.get(ptyId)
    if (existing) {
      return existing
    }
    // Why: trackers are created lazily on the first observed chunk. After an
    // app relaunch the PTY/leaf records can already hold a persisted title; a
    // cold tracker would miss the parked working→idle completion and never
    // arm the stale-title timer for a persisted 'working' title.
    // Why the display clear first: a tracker recreated after a relay drop must not re-arm on the
    // working title the timer already retired.
    const pty = this.ptysById.get(ptyId)
    let initialTitle = pty?.titleDisplayClear?.title ?? pty?.lastOscTitle ?? null
    if (initialTitle === null) {
      for (const leaf of this.getLeavesForPty(ptyId)) {
        if (leaf.lastOscTitle) {
          initialTitle = leaf.lastOscTitle
          break
        }
      }
    }
    const tracker = createTerminalTitleTracker(
      {
        onTitle: (normalizedTitle, rawTitle, meta) => {
          const live = this.ptyTitleTrackersByPtyId.get(ptyId)
          const gateKey = this.makeDecorativeTitleGateKey(rawTitle, normalizedTitle)
          const decorativeOnly = live?.lastMobileTitleGateKey === gateKey
          if (!decorativeOnly && !meta?.staleWorkingTitleClear) {
            void this.recheckHookAgentPresenceForPty(ptyId)
          }
          if (live) {
            live.lastMobileTitleGateKey = gateKey
          }
          // Why: the same gate the mobile fan-out below already uses, applied one hop earlier —
          // a spinner frame the renderer store discards should not cost a pty:sideEffect message
          // at all. See decorative-title-fact-emission.ts for why repeats still heartbeat.
          const nowMs = Date.now()
          if (
            shouldEmitTitleFactForFrame({
              decorativeOnly,
              staleWorkingTitleClear: meta?.staleWorkingTitleClear === true,
              lastEmittedAtMs: live?.lastTitleFactAtMs ?? null,
              nowMs
            })
          ) {
            if (live) {
              live.lastTitleFactAtMs = nowMs
            }
            this.recordTerminalSideEffectFact(ptyId, {
              kind: 'title',
              normalizedTitle,
              rawTitle,
              ...(meta?.staleWorkingTitleClear ? { staleWorkingTitleClear: true } : {})
            })
          }
          const changed = this.applyTrackedPtyTitle(ptyId, rawTitle, normalizedTitle, meta)
          const identityOnlyTitle = this.isLiveCursorNativeTitle(rawTitle, meta)
          const tracksReplicatedStatus =
            live?.applyingChunk === true && this.mobileSessionTabListeners.size > 0
          const titleStatus = tracksReplicatedStatus ? detectAgentStatusFromTitle(rawTitle) : null
          if (
            tracksReplicatedStatus &&
            decorativeOnly &&
            !this.ptyForegroundAgent.hasDelayedSnapshot(ptyId) &&
            (titleStatus === 'working' || titleStatus === 'permission')
          ) {
            // Normalized Pi/Gemini/Grok frames still renew the replicated status lease.
            this.mobileSessionTabsAgentStatusHeartbeat.scheduleDecorativeHeartbeat(ptyId)
          }
          // Why: an identity-only cursor title records nothing, but the tracker
          // title is that pane's only Cursor identity and must still fan out (#10258).
          if (!changed && !identityOnlyTitle) {
            return
          }
          if (live?.applyingChunk) {
            // Why: synthetic spinner ticks change only the braille glyph
            // ~12.5x/sec; fanning out full mobile session snapshots per frame
            // is pure churn. Raw lastOscTitle updates above stay cheap.
            if (!decorativeOnly) {
              this.mobileSessionTabsAgentStatusHeartbeat.observeSemanticTitle(ptyId)
              live.chunkTouchedSessionTabs = true
            }
          } else {
            // Stale-working-title timer path — fires between chunks, so the
            // per-chunk batching in onPtyData cannot pick it up.
            this.mobileSessionTabsAgentStatusHeartbeat.observeSemanticTitle(ptyId)
            this.touchMobileSessionSnapshotsForPty(ptyId)
          }
        },
        // Why: agent transitions and bells become pty:sideEffect facts —
        // main is the single byte parser for local/SSH PTYs; the renderer
        // store handler decides what the facts mean (notification policy).
        onAgentBecameWorking: () => {
          this.recordTerminalSideEffectFact(ptyId, { kind: 'agent-working' })
        },
        onAgentBecameIdle: (title, meta) => {
          this.recordTerminalSideEffectFact(ptyId, {
            kind: 'agent-idle',
            title,
            ...(meta?.staleWorkingTitleClear ? { staleWorkingTitleClear: true } : {})
          })
        },
        onAgentExited: () => {
          this.confirmPtyAgentExit(ptyId)
        },
        onCommandStarted: () => {
          this.openCodeRunLifetime.onCommandStarted(ptyId)
        },
        onCommandFinished: (exitCode: number | null) => {
          void this.recheckHookAgentPresenceForPty(ptyId)
          this.retirePtyAgentLaunchAuthority(ptyId)
          this.recordTerminalSideEffectFact(ptyId, { kind: 'command-finished', exitCode })
          this.openCodeRunLifetime.onCommandFinished(ptyId, exitCode)
        },
        onBell: () => {
          this.recordTerminalSideEffectFact(ptyId, { kind: 'bell' })
        },
        onPrLink: (link: TerminalGitHubPRLink) => {
          this.recordTerminalSideEffectFact(ptyId, { kind: 'pr-link', link })
        },
        // Why: hidden-delivery-gated views never see 2031 bytes; facts keep their theme registry truthful.
        onMode2031Subscribe: () => {
          this.recordTerminalSideEffectFact(ptyId, { kind: '2031-subscribe' })
        },
        onMode2031Unsubscribe: () => {
          this.recordTerminalSideEffectFact(ptyId, { kind: '2031-unsubscribe' })
        }
      },
      initialTitle !== null ? { initialTitle } : {}
    )
    tracker.setTransientSideEffectScanningEnabled(this.terminalSideEffectConsumerAvailable)
    const entry: RuntimePtyTitleTrackerEntry = {
      tracker,
      applyingChunk: false,
      lastMobileTitleGateKey: null,
      lastTitleFactAtMs: null,
      chunkTouchedSessionTabs: false,
      pendingFacts: [],
      afterFacts: [],
      // Why: command-code facts exist only for the pty:sideEffect channel —
      // headless serve skips the per-chunk scrape entirely. The detector
      // self-arms on the Command Code banner; the spawn command (when main
      // saw one) mirrors the renderer detector's startupCommand fast-arm.
      commandCodeDetector: this.terminalSideEffectConsumerAvailable
        ? this.createTerminalSideEffectCommandCodeDetector(ptyId)
        : null
    }
    this.ptyTitleTrackersByPtyId.set(ptyId, entry)
    return entry
  }
}
