/* oxlint-disable max-lines -- Why: history error-logging .catch() chains add ~10 lines of
safety wiring spread across spawn/event-routing; splitting would scatter tightly coupled
adapter ↔ history lifecycle logic. */
import { basename } from 'node:path'
import { existsSync } from 'node:fs'
import { DaemonClient } from './client'
import { getMacDaemonSystemResolverHealth } from './daemon-health'
import { HistoryManager } from './history-manager'
import { HistoryReader, type ColdRestoreInfo } from './history-reader'
import { mintPtySessionId, parsePtySessionId } from './pty-session-id'
import { supportsPtyStartupBarrier } from './shell-ready'
import { CODEX_SHELL_READY_TIMEOUT_MS } from './session'
import {
  PROTOCOL_VERSION,
  type CreateOrAttachResult,
  type DaemonEvent,
  type GetSnapshotResult,
  type ListSessionsResult,
  type SessionInfo,
  type TakePendingOutputResult
} from './types'
import type {
  IPtyProvider,
  PtyBackgroundStreamEvent,
  PtyProviderBufferSnapshot,
  PtyProcessInfo,
  PtySpawnOptions,
  PtySpawnResult
} from '../providers/types'
import { isShellProcess } from '../../shared/agent-detection'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { shouldUseShellReadyStartupDelivery } from '../../shared/codex-startup-delivery'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'

type ColdRestorePayload = {
  scrollback: string
  cwd: string
  oscLinks?: TerminalOscLinkRange[]
}

function getRecoveredHistorySeed(restoreInfo: ColdRestoreInfo): string | null {
  // Why: alt-screen snapshots represent the TUI buffer; prefer its normal
  // scrollback so a dead TUI is not revived as the fresh shell's active screen.
  return restoreInfo.modes.alternateScreen
    ? restoreInfo.scrollbackAnsi || restoreInfo.snapshotAnsi || null
    : restoreInfo.rehydrateSequences + restoreInfo.snapshotAnsi
}

export type DaemonPtyAdapterOptions = {
  socketPath: string
  tokenPath: string
  protocolVersion?: number
  /** Directory for disk-based terminal history. When set, the adapter writes
   *  raw PTY output to disk for cold restore on daemon crash. */
  historyPath?: string
  /** Called when the daemon socket is unreachable (process died). Expected to
   *  fork a fresh daemon so the next connection attempt can succeed. */
  respawn?: () => Promise<void>
}

const MAX_TOMBSTONES = 1000
const MAX_CONCURRENT_CHECKPOINTS = 4

export class TerminalKilledError extends Error {
  constructor(sessionId: string) {
    super(`Session "${sessionId}" was explicitly killed`)
    this.name = 'TerminalKilledError'
  }
}

export class DaemonPtyAdapter implements IPtyProvider {
  readonly protocolVersion: number
  private socketPath: string
  private tokenPath: string
  private client: DaemonClient
  private historyManager: HistoryManager | null
  private historyReader: HistoryReader | null
  private respawnFn: (() => Promise<void>) | null
  // Why: multiple pane mounts can call spawn() concurrently. If the daemon is
  // dead, all calls enter withDaemonRetry's catch block at once. Without a
  // lock, each would fork its own daemon process. This promise coalesces
  // concurrent respawns so only the first caller forks; the rest await it.
  private respawnPromise: Promise<void> | null = null
  private dataListeners: ((payload: {
    id: string
    data: string
    sequenceChars?: number
  }) => void)[] = []
  private exitListeners: ((payload: { id: string; code: number }) => void)[] = []
  private backgroundStreamListeners: ((payload: PtyBackgroundStreamEvent) => void)[] = []
  private removeEventListener: (() => void) | null = null
  private initialCwds = new Map<string, string>()
  // Why: React re-renders and StrictMode double-mounts can call createOrAttach
  // for a session the user just killed. Without tombstones, the daemon would
  // create a fresh session — resurrecting a terminal the user explicitly closed.
  // Uses a Map<id, timestamp> so eviction removes the oldest by insertion order,
  // matching terminal-host.ts tombstone semantics.
  private killedSessionTombstones = new Map<string, number>()
  // Why: React StrictMode double-mounts: mount → cold restore → unmount →
  // mount → ??? The sticky cache returns the same cold restore data on the
  // second mount until the renderer explicitly acknowledges it.
  private coldRestoreCache = new Map<string, ColdRestorePayload>()
  private sleepRestoreSessionIds = new Set<string>()
  private activeSessionIds = new Set<string>()
  private dirtySessionVersions = new Map<string, number>()
  // Why: a cold-restored session is a fresh shell whose on-disk checkpoint and
  // log belong to the pre-crash session. Incremental appends would land on
  // that stale log (and be rejected by its sequence check on restore), so the
  // first tick must re-anchor with a full snapshot checkpoint, which resets
  // the log to a new generation.
  private sessionsNeedingFullCheckpoint = new Set<string>()
  private checkpointTimer: ReturnType<typeof setTimeout> | null = null
  private checkpointInFlight: Promise<void> | null = null
  // Why: checkpoint-based persistence requires the getSnapshot RPC (v4+).
  // Legacy daemons reject it, causing noisy log spam every 5 seconds.
  private supportsCheckpoints: boolean
  // Why: incremental checkpoints require the takePendingOutput RPC (v13+).
  // Against older daemons the tick falls back to full-snapshot checkpoints.
  private supportsIncrementalCheckpoints: boolean
  // Why: producer pause/resume notifications require v19+; legacy daemons
  // must never see them, so gating makes them silent no-ops there.
  private supportsProducerFlowControl: boolean
  private supportsAuthoritativeBufferSnapshots: boolean
  private pausedProducerSessionIds = new Set<string>()
  // Why tracked here: the daemon's background set (keep-tail stream thinning
  // + transient-fact scan authority) dies with the daemon process/socket;
  // re-sync it on a fresh connection so hidden panes stay thinned.
  private backgroundedSessionIds = new Set<string>()
  // Why: a daemon that survives a socket drop can still hold a pause whose
  // resume died with the connection. Owe those sessions a resume on the next
  // connect; the daemon's 5s failsafe covers the window in between.
  private producerResumesOwedOnReconnect = new Set<string>()
  private static CHECKPOINT_INTERVAL_MS = 5_000
  // Why: a streaming session (build logs, `yes`) re-triggers a full multi-MB
  // snapshot checkpoint on every 5s tick via pending-buffer overflow or the
  // log-size cap — hundreds of MB/min of disk writes from one busy terminal.
  // Bounding cap/overflow-triggered snapshots per session trades bounded
  // cold-crash scrollback staleness (warm reattach and final checkpoints are
  // unaffected and bypass this) for a ~9x cut in worst-case write volume.
  private static FULL_CHECKPOINT_COOLDOWN_MS = 45_000
  private lastFullCheckpointAt = new Map<string, number>()

  constructor(opts: DaemonPtyAdapterOptions) {
    this.protocolVersion = opts.protocolVersion ?? PROTOCOL_VERSION
    this.socketPath = opts.socketPath
    this.tokenPath = opts.tokenPath
    this.client = new DaemonClient({
      socketPath: opts.socketPath,
      tokenPath: opts.tokenPath,
      protocolVersion: opts.protocolVersion
    })
    this.historyManager = opts.historyPath ? new HistoryManager(opts.historyPath) : null
    this.historyReader = opts.historyPath ? new HistoryReader(opts.historyPath) : null
    this.respawnFn = opts.respawn ?? null
    this.supportsCheckpoints = this.protocolVersion >= 4
    this.supportsIncrementalCheckpoints = this.protocolVersion >= 13
    this.supportsProducerFlowControl = this.protocolVersion >= 19
    this.supportsAuthoritativeBufferSnapshots = this.protocolVersion >= 20
    this.client.onDisconnected(() => {
      for (const id of this.pausedProducerSessionIds) {
        this.producerResumesOwedOnReconnect.add(id)
      }
      this.pausedProducerSessionIds.clear()
    })
  }

  getHistoryManager(): HistoryManager | null {
    return this.historyManager
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    return this.withDaemonRetry(() => this.doSpawn(opts))
  }

  private async doSpawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    const sessionId = opts.sessionId ?? mintPtySessionId(opts.worktreeId)

    if (this.killedSessionTombstones.has(sessionId)) {
      throw new TerminalKilledError(sessionId)
    }

    if (opts.isNewSession) {
      await this.replaceUnhealthyMacResolverDaemonBeforeNewPty()
    }

    await this.ensureConnected()
    // Why before createOrAttach: a preserved v19 daemon may remember this
    // session as backgrounded. Ordered control delivery clears it before any
    // newly attached stream bytes can be thinned without a recoverable seq.
    if (!this.supportsAuthoritativeBufferSnapshots) {
      this.setPtyBackgrounded(sessionId, false)
    }

    // Why: detect crash-recovery history before spawning a replacement PTY so
    // the revived shell inherits the recovered cwd and dimensions instead of
    // whatever the current renderer happened to request on mount.
    // Why probe aliveness first: detectColdRestore synchronously replays the
    // full checkpoint + log (up to ~5MB) through a scratch emulator on the
    // main process, but a live daemon session ignores spawn params and its
    // own snapshot supersedes disk — the replay result would be discarded.
    // getSize is a read-only probe; on error/unsupported it degrades to the
    // full detect.
    let restoreInfo: ColdRestoreInfo | null = null
    let restoreSkippedForLiveSession = false
    if (this.historyReader?.hasRestorableHistory(sessionId)) {
      if ((await this.getAppliedSize(sessionId)) !== null) {
        restoreSkippedForLiveSession = true
      } else {
        restoreInfo = this.historyReader.detectColdRestore(sessionId)
      }
    }
    let effectiveCwd = restoreInfo?.cwd ?? opts.cwd
    let effectiveCols = restoreInfo?.cols ?? opts.cols
    let effectiveRows = restoreInfo?.rows ?? opts.rows

    const shellReadySupported = opts.command ? supportsPtyStartupBarrier(opts.env ?? {}) : false
    const isCodexStartupCommand =
      recognizeAgentProcessFromCommandLine(opts.command)?.agent === 'codex'
    const shouldWaitForShellReady =
      isCodexStartupCommand &&
      shouldUseShellReadyStartupDelivery({
        command: opts.command,
        startupCommandDelivery: opts.startupCommandDelivery
      })
    const shellReadyTimeoutMs =
      shellReadySupported && isCodexStartupCommand && !shouldWaitForShellReady
        ? CODEX_SHELL_READY_TIMEOUT_MS
        : undefined

    const createOrAttach = (historySeed: string | null) =>
      this.client.request<CreateOrAttachResult>('createOrAttach', {
        sessionId,
        cols: effectiveCols,
        rows: effectiveRows,
        cwd: effectiveCwd,
        env: opts.env,
        envToDelete: opts.envToDelete,
        command: opts.command,
        startupCommandDelivery: opts.startupCommandDelivery,
        launchAgent: opts.launchAgent,
        // Why: without this, the daemon always spawns cmd.exe (COMSPEC) or
        // PowerShell as a fallback — regardless of which shell the renderer
        // asked for in the "+" menu or persisted as the default. Forwarding
        // the override makes the daemon path behave the same as the in-process
        // LocalPtyProvider.
        shellOverride: opts.shellOverride,
        terminalWindowsWslDistro: opts.terminalWindowsWslDistro,
        terminalWindowsPowerShellImplementation: opts.terminalWindowsPowerShellImplementation,
        shellReadySupported,
        ...(shellReadyTimeoutMs !== undefined ? { shellReadyTimeoutMs } : {}),
        ...(historySeed ? { historySeed } : {})
      })

    let scrollback = restoreInfo ? getRecoveredHistorySeed(restoreInfo) : null
    let result = await createOrAttach(scrollback)
    const launchIdentity = (): { launchAgent?: NonNullable<typeof result.launchAgent> } =>
      result.launchAgent ? { launchAgent: result.launchAgent } : {}

    if (effectiveCwd) {
      this.initialCwds.set(sessionId, effectiveCwd)
    }

    // Why: the daemon RPC returns the shell pid of the backing subprocess.
    // Surfacing it through PtySpawnResult lets ipc/pty register with the
    // memory collector without a provider-specific accessor.
    let pid = typeof result.pid === 'number' && result.pid > 0 ? result.pid : null

    // Why: check sticky cache first — StrictMode double-mounts call spawn
    // twice. The second call finds an existing daemon session (isNew=false)
    // but should still return the cached cold restore data.
    const cachedRestore = this.coldRestoreCache.get(sessionId)
    if (cachedRestore) {
      // Why: wake after sleep also lands here, and the slept session's active
      // tracking and history writer were dropped when sleep killed the PTY.
      // Without re-registering both, checkpoints stop after wake and the
      // second sleep/wake cycle restores a blank terminal.
      this.activeSessionIds.add(sessionId)
      if (this.historyManager) {
        this.historyManager.reopenSession(sessionId)
      }
      return {
        id: sessionId,
        pid,
        ...launchIdentity(),
        coldRestore: cachedRestore,
        ...(!result.isNew ? { isReattach: true } : {})
      }
    }

    // Why: the probe→createOrAttach gap is racy — the session can exit (or
    // enter termination) in between, so the daemon spawned a fresh shell.
    // Detect now so scrollback restore matches the unprobed path; only the
    // new shell's cwd/dims came from the renderer request in this rare case.
    // Why ignoreCleanEnd: the raced session's exit event (stream socket) can
    // beat the createOrAttach reply and write endedAt via closeSession; that
    // must not null the restore here, or the openSession branch below would
    // delete the checkpoint instead of restoring it.
    if (result.isNew && restoreSkippedForLiveSession) {
      restoreInfo =
        this.historyReader?.detectColdRestore(sessionId, { ignoreCleanEnd: true }) ?? null
      scrollback = restoreInfo ? getRecoveredHistorySeed(restoreInfo) : null
      if (restoreInfo && scrollback) {
        // Why: the aliveness probe raced with session death, so the first
        // create lacked recovery bytes. Replace it before exposing the PTY.
        await this.client.request('kill', { sessionId, immediate: true })
        effectiveCwd = restoreInfo.cwd
        effectiveCols = restoreInfo.cols
        effectiveRows = restoreInfo.rows
        result = await createOrAttach(scrollback)
        pid = typeof result.pid === 'number' && result.pid > 0 ? result.pid : null
        this.initialCwds.set(sessionId, effectiveCwd)
      }
    } else if (!result.isNew && result.historySeeded === false) {
      restoreInfo = this.historyReader?.detectColdRestore(sessionId) ?? null
      scrollback = restoreInfo ? getRecoveredHistorySeed(restoreInfo) : null
    }

    const wasAlreadyManaged = this.activeSessionIds.has(sessionId)
    this.activeSessionIds.add(sessionId)

    // Cold restore: daemon created a new session but disk history shows
    // an unclean shutdown → return saved scrollback so the renderer can
    // display the previous terminal content.
    if (restoreInfo && (result.isNew || result.historySeeded === false)) {
      const coldRestore = this.buildColdRestorePayload(restoreInfo)
      const canReanchorHistory = !scrollback || result.historySeeded === true
      // Why: use registerWriter (not openSession) to avoid deleting the
      // existing checkpoint.json. If the revived daemon crashes again before
      // the next 5s tick, the checkpoint is the only recovery data available.
      if (this.historyManager) {
        if (canReanchorHistory) {
          this.historyManager.registerWriter(sessionId)
          this.sessionsNeedingFullCheckpoint.add(sessionId)
          // Why: the revived generation has no valid checkpoint of its own; a
          // cooldown inherited from the pre-crash generation (daemon respawn
          // within one adapter) must not defer this re-anchor.
          this.lastFullCheckpointAt.delete(sessionId)
        } else {
          // Preserve the old recovery files when the new daemon cannot include
          // them; a fresh-only checkpoint would make the data loss permanent.
          this.historyManager.suspendSession(sessionId)
        }
      }
      if (coldRestore) {
        this.coldRestoreCache.set(sessionId, coldRestore)
        return {
          id: sessionId,
          pid,
          ...launchIdentity(),
          coldRestore,
          ...(!result.isNew ? { isReattach: true } : {})
        }
      }
      return { id: sessionId, pid, ...launchIdentity() }
    }

    if (this.historyManager && result.isNew) {
      void this.historyManager
        .openSession(sessionId, {
          cwd: effectiveCwd ?? '',
          cols: effectiveCols,
          rows: effectiveRows
        })
        .catch((err) => console.warn('[history] openSession failed:', sessionId, err))
    } else if (this.historyManager && result.historySeeded === false) {
      // Why: the daemon keeps this failure bit with the live session, so a new
      // adapter cannot promote its fresh-only snapshot after an app restart.
      this.historyManager.suspendSession(sessionId)
    } else if (this.historyManager) {
      // Why: on warm reattach after app relaunch, the HistoryManager is a
      // fresh instance with no writers. registerWriter adds the writer
      // without overwriting meta.json or deleting the existing checkpoint
      // (which is the only valid recovery data until the next tick).
      this.historyManager.registerWriter(sessionId)
      if (!wasAlreadyManaged) {
        // Why: a previous adapter may have drained daemon records it never
        // persisted (a deferred hot-session tick) before the app died.
        // Appending increments past that unknown drain point would put a seq
        // gap in the log, which the restore reader rejects wholesale. Force a
        // full snapshot to re-anchor before any further appends.
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        this.lastFullCheckpointAt.delete(sessionId)
      }
    }

    const isReattach = !result.isNew
    if (!isReattach || !result.snapshot) {
      return {
        id: sessionId,
        pid,
        ...launchIdentity(),
        ...(isReattach ? { isReattach: true } : {})
      }
    }

    const isAltScreen = result.snapshot.modes.alternateScreen
    const snapshotPayload =
      result.snapshot.scrollbackAnsi +
      result.snapshot.rehydrateSequences +
      result.snapshot.snapshotAnsi
    // Why kitty flags ride beside the payload, not inside it: the snapshot
    // string reaches renderer xterms too, where POST_REPLAY_REATTACH_RESET's
    // deliberate kitty reset must win. Only the runtime emulator re-seed
    // consumes the flags (terminal-query-authority.md §kitty).
    const kittyKeyboardFlags = result.snapshot.modes.kittyKeyboardFlags
    return {
      id: sessionId,
      pid,
      ...launchIdentity(),
      snapshot: snapshotPayload,
      snapshotCols: result.snapshot.cols,
      snapshotRows: result.snapshot.rows,
      ...(typeof kittyKeyboardFlags === 'number' && kittyKeyboardFlags > 0
        ? { snapshotKittyKeyboardFlags: kittyKeyboardFlags }
        : {}),
      isReattach: true,
      isAlternateScreen: isAltScreen,
      // Why: carry the mid-escape tail so the renderer can write it after the
      // reattach reset — without it the local daemon reattach path renders a
      // split escape's continuation literally, unlike the remote path (#7329).
      ...(result.snapshot.pendingEscapeTailAnsi
        ? { pendingEscapeTailAnsi: result.snapshot.pendingEscapeTailAnsi }
        : {})
    }
  }

  async attach(id: string): Promise<void> {
    await this.ensureConnected()
    if (!this.supportsAuthoritativeBufferSnapshots) {
      this.setPtyBackgrounded(id, false)
    }

    await this.client.request<CreateOrAttachResult>('createOrAttach', {
      sessionId: id,
      cols: 80,
      rows: 24
    })
  }

  hasPty(id: string): boolean {
    return this.activeSessionIds.has(id)
  }

  write(id: string, data: string): void {
    this.markSessionDirty(id)
    this.client.notify('write', { sessionId: id, data })
  }

  resize(id: string, cols: number, rows: number): void {
    this.markSessionDirty(id)
    this.client.notify('resize', { sessionId: id, cols, rows })
  }

  pauseProducer(id: string): void {
    if (!this.supportsProducerFlowControl) {
      return
    }
    this.pausedProducerSessionIds.add(id)
    this.client.notify('pausePty', { sessionId: id })
  }

  resumeProducer(id: string): void {
    this.producerResumesOwedOnReconnect.delete(id)
    if (!this.supportsProducerFlowControl) {
      return
    }
    this.pausedProducerSessionIds.delete(id)
    this.client.notify('resumePty', { sessionId: id })
  }

  // Why fire-and-forget (like pausePty): a delivery hint for the daemon's
  // keep-tail stream thinning.
  setPtyBackgrounded(id: string, background: boolean): void {
    if (!this.supportsProducerFlowControl) {
      return
    }
    // Why: preserved v19 daemons can thin but cannot return the absolute
    // snapshot sequence needed to recover a gap. Clear their stale hint too.
    const safeBackground = this.supportsAuthoritativeBufferSnapshots && background
    if (safeBackground) {
      this.backgroundedSessionIds.add(id)
    } else {
      this.backgroundedSessionIds.delete(id)
    }
    this.client.notify('setSessionBackground', { sessionId: id, background: safeBackground })
  }

  async shutdown(id: string, opts: { immediate?: boolean; keepHistory?: boolean }): Promise<void> {
    // Why: sleep/exact-stop kills the live PTY before the periodic checkpoint may run.
    // Force a final snapshot so wake can restore the pane users left.
    if (opts.keepHistory) {
      if (this.checkpointInFlight) {
        await this.checkpointInFlight
      }
      await this.checkpointSessions([id], { final: true, teardown: true })
      const restoreInfo = this.historyReader?.detectColdRestore(id) ?? null
      const coldRestore = restoreInfo ? this.buildColdRestorePayload(restoreInfo) : null
      if (coldRestore) {
        this.coldRestoreCache.set(id, coldRestore)
        this.sleepRestoreSessionIds.add(id)
      }
    }
    await this.client.request('kill', { sessionId: id, immediate: opts.immediate ?? false })
    this.activeSessionIds.delete(id)
    this.dirtySessionVersions.delete(id)
    if (!opts.keepHistory) {
      this.coldRestoreCache.delete(id)
      this.sleepRestoreSessionIds.delete(id)
    }
    // Why: the !keepHistory close path doesn't take a final checkpoint, so a
    // session stranded in sessionsNeedingFullCheckpoint would never be cleared.
    // (Under keepHistory the final checkpoint above already cleared the flag, so
    // this is a harmless no-op there — kept unconditional to cover both paths.)
    this.sessionsNeedingFullCheckpoint.delete(id)
    this.lastFullCheckpointAt.delete(id)
    this.stopCheckpointTimerIfIdle()
    this.initialCwds.delete(id)
    // Why: history removal is for the "user explicitly closed this terminal"
    // path. Sleep also calls shutdown but expects scrollback to survive — wake
    // re-spawns and the cold-restore reader needs the dir intact. Caller
    // indicates intent via opts.keepHistory.
    if (this.historyManager && !opts.keepHistory) {
      void this.historyManager
        .removeSession(id)
        .catch((err) => console.warn('[history] removeSession failed:', id, err))
    }

    // Why: tombstone rejects reattach against a session the user explicitly
    // killed. Sleep legitimately reattaches on wake, so skip both the LRU bump
    // and the size-cap eviction under keepHistory.
    if (!opts.keepHistory) {
      this.killedSessionTombstones.delete(id)
      this.killedSessionTombstones.set(id, Date.now())
      if (this.killedSessionTombstones.size > MAX_TOMBSTONES) {
        const oldest = this.killedSessionTombstones.keys().next().value
        if (oldest) {
          this.killedSessionTombstones.delete(oldest)
        }
      }
    }
  }

  ackColdRestore(sessionId: string): void {
    this.coldRestoreCache.delete(sessionId)
    this.sleepRestoreSessionIds.delete(sessionId)
  }

  clearTombstone(sessionId: string): void {
    this.killedSessionTombstones.delete(sessionId)
  }

  private buildColdRestorePayload(restoreInfo: ColdRestoreInfo): ColdRestorePayload | null {
    // Why prefer scrollbackAnsi for alt-screen: snapshotAnsi is the alt buffer
    // (vim/less/htop); normal sessions use the full snapshot + rehydrate.
    // Why the snapshotAnsi fallback: a hibernated TUI agent (empty scrollback)
    // would otherwise get `|| null` → blank pane on wake. snapshotAnsi *alone*
    // (no rehydrateSequences — they start with \x1b[?1049h, which the
    // renderer's POST_REPLAY_MODE_RESET does NOT undo) lands the last frame as
    // normal scrollback. An empty snapshot still yields null → no-op.
    const scrollback = restoreInfo.modes.alternateScreen
      ? restoreInfo.scrollbackAnsi || restoreInfo.snapshotAnsi || null
      : restoreInfo.rehydrateSequences + restoreInfo.snapshotAnsi
    if (!scrollback) {
      return null
    }
    return { scrollback, cwd: restoreInfo.cwd, oscLinks: restoreInfo.oscLinks }
  }

  async sendSignal(id: string, signal: string): Promise<void> {
    await this.client.request('signal', { sessionId: id, signal })
  }

  async getCwd(id: string): Promise<string> {
    try {
      const result = await this.client.request<{ cwd: string | null }>('getCwd', {
        sessionId: id
      })
      return result.cwd ?? ''
    } catch {
      return ''
    }
  }

  async getInitialCwd(id: string): Promise<string> {
    return this.initialCwds.get(id) ?? ''
  }

  // Why: resize() is a fire-and-forget notify, so a resize can be dropped
  // daemon-side (session not yet alive, exited, invalid dims, cold-restore
  // snapshot-col coercion) without the renderer knowing. This reads the size
  // the daemon actually applied so the renderer can detect that drift on resume
  // and re-assert. Null (RPC failure / unknown session) means "cannot confirm",
  // which the renderer treats as a cue to re-forward once.
  async getAppliedSize(id: string): Promise<{ cols: number; rows: number } | null> {
    try {
      const result = await this.client.request<{ size: { cols: number; rows: number } | null }>(
        'getSize',
        { sessionId: id }
      )
      return result.size ?? null
    } catch {
      return null
    }
  }

  async getBufferSnapshot(
    id: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<PtyProviderBufferSnapshot | null> {
    if (!this.supportsAuthoritativeBufferSnapshots) {
      return null
    }
    try {
      const result = await this.client.request<GetSnapshotResult>('getSnapshot', {
        sessionId: id,
        ...(typeof opts.scrollbackRows === 'number' ? { scrollbackRows: opts.scrollbackRows } : {})
      })
      const snapshot = result.snapshot
      // Why: older v19 daemons have no absolute output sequence. Their snapshot
      // cannot safely reconcile stream bytes still queued on the other socket.
      if (!snapshot || typeof snapshot.outputSequence !== 'number') {
        return null
      }
      return {
        data: snapshot.rehydrateSequences + snapshot.snapshotAnsi,
        scrollbackAnsi: snapshot.scrollbackAnsi,
        cols: snapshot.cols,
        rows: snapshot.rows,
        cwd: snapshot.cwd,
        lastTitle: snapshot.lastTitle,
        seq: snapshot.outputSequence,
        source: 'headless',
        oscLinks: snapshot.oscLinks,
        alternateScreen: snapshot.modes.alternateScreen,
        ...(snapshot.pendingEscapeTailAnsi
          ? { pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi }
          : {})
      }
    } catch {
      return null
    }
  }

  async clearBuffer(id: string): Promise<void> {
    await this.client.request('clearScrollback', { sessionId: id })
    this.markSessionDirty(id)
  }

  acknowledgeDataEvent(_id: string, _charCount: number): void {
    // No flow control for daemon-backed terminals
  }

  async hasChildProcesses(id: string): Promise<boolean> {
    const foregroundProcess = await this.getForegroundProcess(id)
    // Why: daemon-backed PTYs can host long-lived agents while the renderer is
    // detached. Cleanup prompts must not treat those sessions like idle shells.
    return foregroundProcess !== null && !isShellProcess(foregroundProcess)
  }

  async getForegroundProcess(id: string): Promise<string | null> {
    try {
      const result = await this.client.request<{ foregroundProcess: string | null }>(
        'getForegroundProcess',
        { sessionId: id }
      )
      return result.foregroundProcess
    } catch {
      return null
    }
  }

  async confirmForegroundProcess(id: string): Promise<string | null> {
    try {
      const result = await this.client.request<{ foregroundProcess: string | null }>(
        'confirmForegroundProcess',
        { sessionId: id }
      )
      return result.foregroundProcess
    } catch {
      return null
    }
  }

  async serialize(ids: string[]): Promise<string> {
    const sessions: Record<string, { initialCwd?: string }> = {}
    for (const id of ids) {
      sessions[id] = { initialCwd: this.initialCwds.get(id) }
    }
    return JSON.stringify(sessions)
  }

  async revive(_state: string): Promise<void> {
    // Sessions already live in the daemon — no revival needed
  }

  /** Called on app launch. Lists daemon sessions, kills orphans whose
   *  workspaceId no longer exists, and caches alive session IDs.
   *
   *  IMPORTANT: a session id embeds the worktree id it was minted under, which is
   *  the worktree's *path* at spawn time. When a worktree folder is renamed, its
   *  id changes but live sessions keep the old id. Callers MUST therefore seed
   *  `validWorktreeIds` with each live worktree's `WorktreeMeta.priorWorktreeIds`
   *  (the pre-rename aliases) or those sessions will be reaped as false orphans.
   *  This reconcile has no production caller yet; wire the alias in when it gains
   *  one. */
  async reconcileOnStartup(validWorktreeIds: Set<string>): Promise<{
    alive: string[]
    killed: string[]
  }> {
    await this.ensureConnected()
    const result = await this.client.request<ListSessionsResult>('listSessions', undefined)

    const alive: string[] = []
    const killed: string[] = []

    for (const session of result.sessions) {
      if (!session.isAlive) {
        continue
      }
      // Why: session IDs use the format `${worktreeId}@@${shortUuid}`. Sessions
      // whose id does not match the minted format (worktreeId === null) cannot
      // be tied to a live worktree and are treated as orphans.
      const { worktreeId } = parsePtySessionId(session.sessionId)

      if (worktreeId === null || !validWorktreeIds.has(worktreeId)) {
        try {
          await this.client.request('kill', { sessionId: session.sessionId })
        } catch {
          /* already dead */
        }
        killed.push(session.sessionId)
      } else {
        alive.push(session.sessionId)
        // Why: background sessions discovered here may produce output before
        // the user reattaches their pane. Without adding them to the checkpoint
        // set, disconnectOnly()'s final checkpoint would skip them, leaving
        // stale recovery data if the daemon later crashes.
        this.activeSessionIds.add(session.sessionId)
        this.historyManager?.registerWriter(session.sessionId)
      }
    }

    return { alive, killed }
  }

  async listProcesses(): Promise<PtyProcessInfo[]> {
    await this.ensureConnected()
    const result = await this.client.request<ListSessionsResult>('listSessions', undefined)
    return result.sessions
      .filter((s) => s.isAlive)
      .map((s) => ({
        id: s.sessionId,
        cwd: s.cwd ?? '',
        title: 'shell',
        ...(s.terminalHandle ? { terminalHandle: s.terminalHandle } : {})
      }))
  }

  // Why: the Manage Sessions panel needs the full SessionInfo (pid, state,
  // createdAt) per session for display; listProcesses drops that detail for
  // the IPtyProvider contract. Keep both in parallel rather than widening
  // the provider surface.
  async listSessions(): Promise<SessionInfo[]> {
    await this.ensureConnected()
    const result = await this.client.request<ListSessionsResult>('listSessions', undefined)
    return result.sessions.filter((s) => s.isAlive)
  }

  getActiveSessionIds(): string[] {
    return [...this.activeSessionIds]
  }

  // Why: used by the "Restart daemon" handler to synthesize pty:exit for every
  // live session *before* tearing down the adapter. The daemon's own
  // kill-all-and-shutdown path explicitly suppresses onExit fanout
  // (session.ts:246-252), so without this the renderer panes would black-hole
  // writes to a disposed adapter forever. Reuses the existing exitListeners
  // path so downstream cleanup (clearProviderPtyState, markClaudePtyExited,
  // renderer pty:exit) runs exactly as it does on natural exit.
  fanoutSyntheticExits(code: number): void {
    const ids = [...this.activeSessionIds]
    this.activeSessionIds.clear()
    this.dirtySessionVersions.clear()
    this.lastFullCheckpointAt.clear()
    this.sessionsNeedingFullCheckpoint.clear()
    this.pausedProducerSessionIds.clear()
    this.producerResumesOwedOnReconnect.clear()
    this.stopCheckpointTimer()
    for (const id of ids) {
      this.coldRestoreCache.delete(id)
      // Why: listener throws are intentionally *not* caught — matches the
      // natural onExit fanout in setupEventRouting, so synthetic exits don't
      // diverge in error semantics from real ones. A throwing listener is a
      // bug that should surface loudly, not be silently swallowed.
      // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
      for (const listener of [...this.exitListeners]) {
        listener({ id, code })
      }
    }
  }

  async getDefaultShell(): Promise<string> {
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'powershell.exe'
    }
    return process.env.SHELL || '/bin/zsh'
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    if (process.platform === 'win32') {
      return [
        { name: 'PowerShell', path: 'powershell.exe' },
        { name: 'Command Prompt', path: 'cmd.exe' }
      ]
    }
    const shells = ['/bin/zsh', '/bin/bash', '/bin/sh']
    return shells.filter((s) => existsSync(s)).map((s) => ({ name: basename(s), path: s }))
  }

  onData(
    callback: (payload: { id: string; data: string; sequenceChars?: number }) => void
  ): () => void {
    this.dataListeners.push(callback)
    return () => {
      const idx = this.dataListeners.indexOf(callback)
      if (idx !== -1) {
        this.dataListeners.splice(idx, 1)
      }
    }
  }

  onBackgroundStreamEvent(callback: (payload: PtyBackgroundStreamEvent) => void): () => void {
    this.backgroundStreamListeners.push(callback)
    return () => {
      const idx = this.backgroundStreamListeners.indexOf(callback)
      if (idx !== -1) {
        this.backgroundStreamListeners.splice(idx, 1)
      }
    }
  }

  onReplay(_callback: (payload: { id: string; data: string }) => void): () => void {
    return () => {}
  }

  onExit(callback: (payload: { id: string; code: number }) => void): () => void {
    this.exitListeners.push(callback)
    return () => {
      const idx = this.exitListeners.indexOf(callback)
      if (idx !== -1) {
        this.exitListeners.splice(idx, 1)
      }
    }
  }

  dispose(): void {
    this.stopCheckpointTimer()
    this.dirtySessionVersions.clear()
    this.lastFullCheckpointAt.clear()
    this.coldRestoreCache.clear()
    this.pausedProducerSessionIds.clear()
    this.producerResumesOwedOnReconnect.clear()
    this.removeEventListener?.()
    this.removeEventListener = null
    // Why: final checkpoints are written daemon-side in TerminalHost.dispose()
    // which has direct access to sessions. The adapter only marks sessions as
    // cleanly ended here so they don't trigger false cold restores.
    if (this.historyManager) {
      void this.historyManager
        .dispose()
        .catch((err) => console.warn('[history] dispose failed:', err))
    }
    this.client.disconnect()
  }

  // Why: for in-process daemon mode, disconnect without flushing history.
  // dispose() writes endedAt for all sessions, which would prevent cold
  // restore. disconnectOnly() leaves history files in unclean state so
  // the next launch detects them as crash-recoverable.
  // We write a final checkpoint before disconnecting so that if the daemon
  // later crashes while Orca is closed, checkpoint.json has recovery data.
  async disconnectOnly(): Promise<void> {
    this.stopCheckpointTimer()
    // Why: wait for any in-flight timer pass to finish before starting
    // the final checkpoint. Otherwise both passes race on the shared tmp
    // file, risking ENOENT on rename and disabling future writes.
    if (this.checkpointInFlight) {
      await this.checkpointInFlight
    }
    // Why: without a final checkpoint, sessions opened after the last timer
    // tick have no checkpoint.json on disk. If the detached daemon later
    // dies, detectColdRestore finds nothing to restore from. Must await
    // before disconnecting — fire-and-forget would race with client.disconnect()
    // and the pending getSnapshot RPCs would be rejected.
    await this.checkpointAllSessions()
    this.dirtySessionVersions.clear()
    this.lastFullCheckpointAt.clear()
    this.coldRestoreCache.clear()
    // Why: the detached daemon keeps these PTYs alive for warm reattach; a
    // pause left behind would block their shells for a failsafe window.
    for (const id of this.pausedProducerSessionIds) {
      this.client.notify('resumePty', { sessionId: id })
    }
    this.pausedProducerSessionIds.clear()
    this.producerResumesOwedOnReconnect.clear()
    this.removeEventListener?.()
    this.removeEventListener = null
    this.client.disconnect()
  }

  private async ensureConnected(): Promise<void> {
    await this.client.ensureConnected()
    // Why sampled before setupEventRouting: routing is (re)installed exactly
    // once per connection, so "no listener yet" identifies a fresh connect —
    // the only time the daemon-side backgrounded set needs a resync (it is
    // process state that died with the previous daemon/socket).
    const isFreshConnection = this.removeEventListener === null
    this.setupEventRouting()
    this.scheduleCheckpointTimer()
    this.flushOwedProducerResumes()
    if (isFreshConnection) {
      this.resyncBackgroundedSessions()
    }
  }

  private resyncBackgroundedSessions(): void {
    for (const id of this.backgroundedSessionIds) {
      // Harmless no-op for sessions the daemon doesn't know (yet).
      this.client.notify('setSessionBackground', { sessionId: id, background: true })
    }
  }

  private flushOwedProducerResumes(): void {
    if (this.producerResumesOwedOnReconnect.size === 0) {
      return
    }
    for (const id of this.producerResumesOwedOnReconnect) {
      // Why: resuming a session the fresh daemon doesn't know is a harmless
      // no-op; leaving a survivor paused would waste 5s of failsafe latency.
      this.client.notify('resumePty', { sessionId: id })
    }
    this.producerResumesOwedOnReconnect.clear()
  }

  private stopCheckpointTimer(): void {
    if (!this.checkpointTimer) {
      return
    }
    clearTimeout(this.checkpointTimer)
    this.checkpointTimer = null
  }

  private stopCheckpointTimerIfIdle(): void {
    if (this.dirtySessionVersions.size === 0) {
      this.stopCheckpointTimer()
    }
  }

  private scheduleCheckpointTimer(): void {
    if (
      this.checkpointTimer ||
      !this.historyManager ||
      !this.supportsCheckpoints ||
      this.dirtySessionVersions.size === 0
    ) {
      return
    }
    // Why: checkpointing is only needed after terminal data/resize/write marks
    // a session dirty. A permanent interval woke the main process every 5s for
    // idle daemon-backed terminals just to discover there was nothing to write.
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = null
      // Why: if the previous pass is still in-flight (slow RPC or disk),
      // retry later instead of overlapping checkpoint() writes to the same tmp
      // file, which can lose a rename and disable future history writes.
      if (this.checkpointInFlight) {
        this.scheduleCheckpointTimer()
        return
      }
      this.checkpointInFlight = this.checkpointDirtySessions().finally(() => {
        this.checkpointInFlight = null
        this.scheduleCheckpointTimer()
      })
    }, DaemonPtyAdapter.CHECKPOINT_INTERVAL_MS)
  }

  private markSessionDirty(sessionId: string): void {
    if (!this.activeSessionIds.has(sessionId)) {
      return
    }
    this.dirtySessionVersions.set(sessionId, (this.dirtySessionVersions.get(sessionId) ?? 0) + 1)
    this.scheduleCheckpointTimer()
  }

  private async checkpointDirtySessions(): Promise<void> {
    if (!this.historyManager || this.dirtySessionVersions.size === 0) {
      return
    }
    // Why: getSnapshot serializes the daemon's terminal buffer. On large
    // workspaces, checkpointing every live idle session every 5s burns CPU and
    // disk for identical payloads; dirty versions keep retries precise without
    // dropping writes that arrive during an in-flight checkpoint.
    const versions = new Map(
      [...this.dirtySessionVersions].filter(([sessionId]) => this.activeSessionIds.has(sessionId))
    )
    if (versions.size === 0) {
      this.dirtySessionVersions.clear()
      this.stopCheckpointTimer()
      return
    }
    const completed = await this.checkpointSessions(versions.keys())
    for (const [sessionId, version] of versions) {
      if (completed.has(sessionId) && this.dirtySessionVersions.get(sessionId) === version) {
        this.dirtySessionVersions.delete(sessionId)
      }
    }
    this.stopCheckpointTimerIfIdle()
  }

  // Why: the adapter runs in the Electron main process and does not have direct
  // access to daemon Session objects. It calls checkpoint RPCs over the daemon
  // socket per session. Returns a promise that resolves when all checkpoint
  // writes complete (callers that don't need to wait can void it).
  // Why final=true here: this runs on clean disconnect, where the full-depth
  // snapshot (not the increment log) must be the restore source. It is not a
  // teardown snapshot: the detached daemon and its PTYs keep running for warm
  // reattach, so shell-ready scanner state must remain intact.
  private async checkpointAllSessions(): Promise<void> {
    const completed = await this.checkpointSessions(this.activeSessionIds, { final: true })
    for (const sessionId of completed) {
      this.dirtySessionVersions.delete(sessionId)
    }
  }

  private async checkpointSessions(
    sessionIds: Iterable<string>,
    opts?: { final?: boolean; teardown?: boolean }
  ): Promise<Set<string>> {
    const completed = new Set<string>()
    if (!this.historyManager) {
      return completed
    }
    const ids = Array.from(sessionIds)
    let nextIndex = 0

    const checkpointNext = async (): Promise<void> => {
      for (;;) {
        const index = nextIndex
        nextIndex++
        if (index >= ids.length) {
          return
        }
        const sessionId = ids[index]
        await this.checkpointSession(sessionId, {
          final: opts?.final === true,
          teardown: opts?.teardown === true
        })
          .then((result) => {
            // Why: deferred sessions stay dirty so the checkpoint timer keeps
            // retrying until their full-snapshot cooldown expires.
            if (result === 'done') {
              completed.add(sessionId)
            }
          })
          .catch((err) => console.warn('[history] checkpoint failed:', sessionId, err))
      }
    }
    // Why: snapshot serialization and checkpoint writes are CPU/disk heavy.
    // Dirty-session filtering keeps idle terminals out; this cap prevents one
    // tick from snapshotting every active dirty terminal at once.
    const workers = Array.from({ length: Math.min(MAX_CONCURRENT_CHECKPOINTS, ids.length) }, () =>
      checkpointNext()
    )
    await Promise.all(workers)
    return completed
  }

  // Why cooldown starts only after a session's FIRST full snapshot: a session
  // with no checkpoint on disk yet must be able to write one immediately or a
  // cold restore would find nothing.
  private isFullCheckpointCoolingDown(sessionId: string): boolean {
    const last = this.lastFullCheckpointAt.get(sessionId)
    if (last === undefined) {
      return false
    }
    const elapsed = Date.now() - last
    // Why elapsed < 0 counts as expired: a backward wall-clock jump must not
    // extend the deferral window.
    return elapsed >= 0 && elapsed < DaemonPtyAdapter.FULL_CHECKPOINT_COOLDOWN_MS
  }

  // Why 'deferred' exists: a cap/overflow-triggered full snapshot inside the
  // cooldown window is postponed, and the session must STAY dirty so the 5s
  // timer keeps retrying until the cooldown expires. While deferred, no
  // takePendingOutput/append runs for the session — appending past a dropped
  // range would leave a hole in the log, whereas skipping keeps the on-disk
  // state a consistent (merely stale) prefix that the eventual full snapshot
  // re-anchors.
  private async checkpointSession(
    sessionId: string,
    opts: { final: boolean; teardown: boolean }
  ): Promise<'done' | 'deferred'> {
    if (!this.supportsIncrementalCheckpoints) {
      const result = await this.client.request<GetSnapshotResult>('getSnapshot', { sessionId })
      if (result.snapshot && this.historyManager) {
        await this.historyManager.checkpoint(sessionId, result.snapshot)
      }
      return 'done'
    }
    if (opts.final || this.sessionsNeedingFullCheckpoint.has(sessionId)) {
      if (!opts.final && this.isFullCheckpointCoolingDown(sessionId)) {
        return 'deferred'
      }
      // Why take-with-snapshot instead of plain getSnapshot: the take clears
      // the daemon's pending records in the same synchronous turn as the
      // serialize. A plain snapshot would leave pre-snapshot records pending;
      // a later warm reattach would append them to the fresh log and cold
      // restore would replay them on top of a checkpoint that already
      // contains them.
      await this.takeSnapshotAndCheckpoint(sessionId, { teardown: opts.teardown })
      this.sessionsNeedingFullCheckpoint.delete(sessionId)
      return 'done'
    }
    const take = await this.client.request<TakePendingOutputResult | null>('takePendingOutput', {
      sessionId
    })
    if (!take) {
      return 'done'
    }
    if (take.overflowed) {
      // Why: overflow dropped records, so the log has a hole — only a full
      // snapshot (which reflects everything ever written) can re-anchor it.
      if (this.isFullCheckpointCoolingDown(sessionId)) {
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        return 'deferred'
      }
      await this.takeSnapshotAndCheckpoint(sessionId, { teardown: false })
      return 'done'
    }
    if (take.records.length === 0) {
      return 'done'
    }
    if (!this.historyManager) {
      return 'done'
    }
    const appendResult = await this.historyManager.appendIncrements(
      sessionId,
      take.seq,
      take.records
    )
    if (appendResult === 'needs-checkpoint') {
      // Why dropping take.records is lossless: they were applied to the live
      // emulator before the take, so the snapshot below contains them.
      if (this.isFullCheckpointCoolingDown(sessionId)) {
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        return 'deferred'
      }
      await this.takeSnapshotAndCheckpoint(sessionId, { teardown: false })
    }
    return 'done'
  }

  private async takeSnapshotAndCheckpoint(
    sessionId: string,
    opts: { teardown: boolean }
  ): Promise<void> {
    const take = await this.client.request<TakePendingOutputResult | null>('takePendingOutput', {
      sessionId,
      includeSnapshot: true,
      teardownSnapshot: opts.teardown
    })
    if (take?.snapshot && this.historyManager) {
      await this.historyManager.checkpoint(sessionId, take.snapshot)
      this.lastFullCheckpointAt.set(sessionId, Date.now())
      if (take.records.length > 0) {
        // Why: take-with-snapshot usually returns no records because the
        // snapshot subsumes them. Held parser-state bytes, such as an
        // incomplete shell-ready marker prefix, are not representable in the
        // snapshot and must remain as a post-checkpoint log tail.
        await this.historyManager.appendIncrements(sessionId, take.seq, take.records)
      }
    }
  }

  // Why: when the daemon process dies, operations fail with ENOENT (socket
  // gone), ECONNREFUSED, or "Connection lost" (socket closed mid-request).
  // Rather than leaving all terminals permanently broken until app restart,
  // this wrapper detects daemon-death errors, tears down the stale client
  // state, forks a fresh daemon via respawnFn, reconnects, and retries the
  // operation once. If respawn itself fails, the error propagates normally.
  private async withDaemonRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (!this.respawnFn || !isDaemonGoneError(err)) {
        throw err
      }
      if (!this.respawnPromise) {
        this.respawnPromise = this.doRespawn().finally(() => {
          this.respawnPromise = null
        })
      }
      await this.respawnPromise
      return await fn()
    }
  }

  private async replaceUnhealthyMacResolverDaemonBeforeNewPty(): Promise<void> {
    if (!this.respawnFn) {
      return
    }

    const health = await getMacDaemonSystemResolverHealth(
      this.socketPath,
      this.tokenPath,
      this.protocolVersion
    )
    if (health !== 'unhealthy') {
      return
    }

    const daemonLiveSessionCount = await this.getDaemonLiveSessionCount()
    const liveSessionCount = Math.max(this.activeSessionIds.size, daemonLiveSessionCount ?? 0)
    if (daemonLiveSessionCount === null || liveSessionCount > 0) {
      console.warn(
        daemonLiveSessionCount === null
          ? '[daemon] macOS system resolver unavailable - preserving daemon because live session state could not be verified'
          : `[daemon] macOS system resolver unavailable - preserving daemon because it owns ${liveSessionCount} live session${liveSessionCount === 1 ? '' : 's'}`
      )
      return
    }

    // Why: replacing the daemon kills its sessions without daemon-side exit
    // fanout. Emit exits first so renderer panes do not write to dead PTYs.
    this.fanoutSyntheticExits(-1)
    if (!this.respawnPromise) {
      this.respawnPromise = this.doRespawn(
        '[daemon] macOS system resolver unavailable - respawning daemon'
      ).finally(() => {
        this.respawnPromise = null
      })
    }
    await this.respawnPromise
  }

  private async getDaemonLiveSessionCount(): Promise<number | null> {
    try {
      await this.client.ensureConnected()
      const result = await this.client.request<ListSessionsResult>('listSessions', undefined)
      return result.sessions.filter((session) => session.isAlive).length
    } catch {
      return null
    }
  }

  private emitBackgroundStreamEvent(payload: PtyBackgroundStreamEvent): void {
    // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
    for (const listener of [...this.backgroundStreamListeners]) {
      listener(payload)
    }
  }

  private async doRespawn(message = '[daemon] Daemon died — respawning'): Promise<void> {
    console.warn(message)
    this.removeEventListener?.()
    this.removeEventListener = null
    this.client.disconnect()
    await this.respawnFn!()
  }

  private setupEventRouting(): void {
    if (this.removeEventListener) {
      return
    }

    this.removeEventListener = this.client.onEvent((raw) => {
      const event = raw as DaemonEvent
      if (event.type !== 'event') {
        return
      }

      if (event.event === 'data') {
        this.markSessionDirty(event.sessionId)
        // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
        for (const listener of [...this.dataListeners]) {
          listener({
            id: event.sessionId,
            data: event.payload.data,
            ...(event.payload.sequenceChars === undefined
              ? {}
              : { sequenceChars: event.payload.sequenceChars })
          })
        }
      } else if (event.event === 'sessionBackgroundMarker') {
        this.emitBackgroundStreamEvent({
          id: event.sessionId,
          kind: 'backgroundMarker',
          background: event.payload.background,
          ...(event.payload.scanSeedAnsi !== undefined
            ? { scanSeedAnsi: event.payload.scanSeedAnsi }
            : {})
        })
      } else if (event.event === 'dataGap') {
        this.emitBackgroundStreamEvent({
          id: event.sessionId,
          kind: 'dataGap',
          droppedChars: event.payload.droppedChars,
          ...(event.payload.sequenceChars === undefined
            ? {}
            : { sequenceChars: event.payload.sequenceChars })
        })
      } else if (event.event === 'transientFact') {
        this.emitBackgroundStreamEvent({
          id: event.sessionId,
          kind: 'transientFact',
          fact: event.payload
        })
      } else if (event.event === 'exit') {
        this.activeSessionIds.delete(event.sessionId)
        this.dirtySessionVersions.delete(event.sessionId)
        // Why: an exited session must not be owed a resume on reconnect — a
        // reused sessionId would receive a stray resumePty. Same for the
        // background set: a reused id must start un-thinned.
        this.pausedProducerSessionIds.delete(event.sessionId)
        this.producerResumesOwedOnReconnect.delete(event.sessionId)
        this.backgroundedSessionIds.delete(event.sessionId)
        if (!this.sleepRestoreSessionIds.has(event.sessionId)) {
          this.coldRestoreCache.delete(event.sessionId)
        }
        // Why: an exited session can never be checkpointed again, so its pending
        // full-checkpoint flag is dead state. Without this, a cold-restored
        // session that exits before its first checkpoint leaks a permanent entry.
        this.sessionsNeedingFullCheckpoint.delete(event.sessionId)
        // Why: a reused sessionId (renderer respawns a persisted ptyId) must
        // not inherit the dead session's snapshot cooldown.
        this.lastFullCheckpointAt.delete(event.sessionId)
        this.stopCheckpointTimerIfIdle()
        if (this.historyManager) {
          void this.historyManager
            .closeSession(event.sessionId, event.payload.code)
            .catch((err) => console.warn('[history] closeSession failed:', event.sessionId, err))
        }
        this.initialCwds.delete(event.sessionId)
        // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
        for (const listener of [...this.exitListeners]) {
          listener({ id: event.sessionId, code: event.payload.code })
        }
      }
    })
  }
}

// Why: ENOENT/ECONNREFUSED with syscall 'connect' mean the socket is
// unreachable (daemon died). Checking syscall avoids false positives from
// token-file ENOENT (readFileSync), which has no syscall or syscall='open'.
// "Connection lost" / "Not connected" mean the daemon died while we had an
// active or stale connection. All indicate the daemon is gone and a respawn
// should be attempted.
function isDaemonGoneError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false
  }
  const errno = err as NodeJS.ErrnoException
  if ((errno.code === 'ENOENT' || errno.code === 'ECONNREFUSED') && errno.syscall === 'connect') {
    return true
  }
  const msg = err.message
  return msg === 'Connection lost' || msg === 'Not connected'
}
