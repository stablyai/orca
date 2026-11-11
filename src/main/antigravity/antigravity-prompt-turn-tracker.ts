import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AcpPromptTurnTracker } from '../acp/protocol/acp-session-runtime-options'
import type { PromptResponse } from '../acp/generated/acp-protocol.generated'
import { AntigravityBackgroundTaskLedger } from './antigravity-background-task-ledger'
import { AntigravityReactiveTurnStreamer } from './antigravity-reactive-turn-streamer'
import { AntigravityTranscriptReader } from './antigravity-transcript-reader'

const ACTIVE_POLL_MS = 300
const MAX_IDLE_POLL_MS = 4_800

export type AntigravityPromptTurnTrackerOptions = {
  geminiHome: string
  activePollMs?: number
  reactiveQuietDoneMs?: number
  now?: () => number
  recoverableTaskIds?: () => ReadonlySet<string> | null
}

/** Create a prompt-turn tracker reading the host `agy` CLI state under `~/.gemini`. */
export function createAntigravityPromptTurnTracker(
  env: NodeJS.ProcessEnv,
  options: Omit<AntigravityPromptTurnTrackerOptions, 'geminiHome'> = {}
): AntigravityPromptTurnTracker {
  const geminiHome = join(env.HOME ?? env.USERPROFILE ?? homedir(), '.gemini')
  return new AntigravityPromptTurnTracker({ geminiHome, ...options })
}

/** Reconcile Antigravity background tasks and stream reactive wakeup turns from brain transcripts. */
export class AntigravityPromptTurnTracker implements AcpPromptTurnTracker {
  private sessionId: string | null = null
  private emit: ((method: string, params: unknown) => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private idlePollMs: number
  private queue: Promise<void> = Promise.resolve()
  private disposed = false

  private readonly reader = new AntigravityTranscriptReader()
  private readonly ledger = new AntigravityBackgroundTaskLedger()
  private readonly streamer = new AntigravityReactiveTurnStreamer()

  private watcherStepCursor = -1
  private initializedFromDisk = false
  private recoveredPersistedTasks = false
  private stalledGapIndex: number | null = null
  private inPrompt = false
  private prePromptStepIndex = -1

  constructor(private readonly options: AntigravityPromptTurnTrackerOptions) {
    this.idlePollMs = options.activePollMs ?? ACTIVE_POLL_MS
  }

  /** Bind the tracker to `sessionId` and schedule polling of its local brain transcript directory. */
  attach(sessionId: string, emit: (method: string, params: unknown) => void): void {
    if (this.sessionId === sessionId && this.emit === emit) {
      return
    }
    this.dispose()
    this.disposed = false
    this.recoveredPersistedTasks = false
    this.stalledGapIndex = null
    this.sessionId = sessionId
    this.emit = emit
    this.scheduleNextPoll(0)
  }

  /** Stop background polling and detach the notification sink. */
  dispose(): void {
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.emit = null
  }

  /** Snapshot transcript state before sending a wire `session/prompt` request. */
  async beginPrompt(): Promise<void> {
    if (!this.sessionId) {
      return
    }
    await this.enqueue(async () => {
      await this.runPoll()
      if (!this.sessionId) {
        return
      }
      this.initializedFromDisk = true
      this.streamer.beginPrompt(this.sessionId, this.emitTurn)
      this.prePromptStepIndex = this.reader.maxStepIndex
      this.inPrompt = true
      this.resetPollDelay()
    })
  }

  /** Reconcile failed-prompt ownership and reset in-flight state when a prompt aborts or throws. */
  abortPrompt(): Promise<void> | void {
    if (!this.sessionId || !this.inPrompt) {
      this.inPrompt = false
      this.streamer.clearPromptCatchup()
      this.streamer.openPromptTools.clear()
      return
    }
    return this.enqueue(async () => {
      const sessionId = this.sessionId
      if (sessionId && this.inPrompt) {
        await this.refreshDisk(sessionId)
        if (this.reader.maxStepIndex >= 0) {
          this.initializedFromDisk = true
          if (this.hasPromptStarted()) {
            const promptOwnedEnd = this.streamer.findPromptOwnedEnd(
              this.reader,
              this.prePromptStepIndex
            )
            this.watcherStepCursor = Math.max(this.watcherStepCursor, promptOwnedEnd)
          }
        }
      }
      this.inPrompt = false
      this.streamer.clearPromptCatchup()
      this.streamer.openPromptTools.clear()
      await this.runPoll()
      this.resetPollDelay()
    })
  }

  /** Filter incoming ACP notifications to suppress lagging duplicates of already-streamed wakeup steps. */
  beforeNotification(method: string, params: unknown): boolean {
    return this.streamer.filterNotification(method, params, this.inPrompt)
  }

  /** Settle backgrounded tool calls from the finished turn and advance the reactive watcher cursor. */
  finishPrompt(response: PromptResponse): Promise<PromptResponse> {
    return this.enqueue(async () => {
      const sessionId = this.sessionId
      if (!sessionId) {
        this.inPrompt = false
        this.streamer.clearPromptCatchup()
        return response
      }
      await this.refreshDisk(sessionId)
      this.initializedFromDisk = true
      const promptOwnedEnd = this.streamer.findPromptOwnedEnd(this.reader, this.prePromptStepIndex)
      this.ledger.settlePromptLaunchers(
        sessionId,
        this.sysDir(sessionId),
        this.reader,
        this.streamer.openPromptTools,
        this.streamer.settledLauncherCallIds,
        this.prePromptStepIndex + 1,
        promptOwnedEnd,
        this.emit,
        this.emitTurn
      )
      this.streamer.clearPromptCatchup()
      this.watcherStepCursor = Math.max(this.watcherStepCursor, promptOwnedEnd)
      this.inPrompt = false
      this.ledger.reconcile(sessionId, this.reader, this.emitTurn)
      await this.runPoll()
      this.resetPollDelay()
      return response
    })
  }

  /** Run a single serialized transcript and message poll cycle. */
  pollOnce(): Promise<void> {
    return this.enqueue(() => this.runPoll()).catch(() => {})
  }

  /** Serialize async disk refreshes and state transitions on a single queue. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work)
    this.queue = next.then(
      () => {},
      () => {}
    )
    return next
  }

  /** Check whether the active prompt already emitted wire frames or wrote a `USER_INPUT` step. */
  private hasPromptStarted(): boolean {
    if (this.streamer.hasPromptWireActivity) {
      return true
    }
    for (let idx = this.prePromptStepIndex + 1; idx <= this.reader.maxStepIndex; idx += 1) {
      if (this.reader.stepsByIndex.get(idx)?.type === 'USER_INPUT') {
        return true
      }
    }
    return false
  }

  /** Read new transcript lines and task messages, reconcile background tasks, and stream reactive steps. */
  private async runPoll(): Promise<void> {
    const sessionId = this.sessionId
    const emit = this.emit
    if (!sessionId || !emit || this.disposed) {
      return
    }
    const prevMax = this.reader.maxStepIndex
    await this.refreshDisk(sessionId)
    if (this.reader.maxStepIndex > prevMax) {
      this.idlePollMs = this.options.activePollMs ?? ACTIVE_POLL_MS
    }
    if (this.reader.maxStepIndex < 0) {
      return
    }
    const sysDir = this.sysDir(sessionId)
    if (!this.initializedFromDisk) {
      this.watcherStepCursor = this.reader.maxStepIndex
      this.initializedFromDisk = true
      const recoverable = this.options.recoverableTaskIds?.() ?? null
      this.recoveredPersistedTasks = recoverable !== null || !this.options.recoverableTaskIds
      this.ledger.seedExisting(sessionId, sysDir, this.reader, this.emitTurn, recoverable)
      return
    }
    if (!this.recoveredPersistedTasks) {
      const recoverable = this.options.recoverableTaskIds?.() ?? null
      if (recoverable !== null) {
        this.recoveredPersistedTasks = true
        this.ledger.reconcileRecoverable(sessionId, this.reader, this.emitTurn, recoverable)
      }
    }
    this.ledger.reconcile(sessionId, this.reader, this.emitTurn)
    if (this.inPrompt) {
      return
    }
    const ctx = {
      sessionId,
      sysDir,
      reader: this.reader,
      ledger: this.ledger,
      emit,
      emitTurn: this.emitTurn
    }
    for (let idx = this.watcherStepCursor + 1; idx <= this.reader.maxStepIndex; idx += 1) {
      const step = this.reader.stepsByIndex.get(idx)
      if (!step) {
        if (this.reader.rejectedStepIndices.has(idx) || this.stalledGapIndex === idx) {
          this.watcherStepCursor = idx
          this.stalledGapIndex = null
          continue
        }
        this.stalledGapIndex = idx
        break
      }
      this.stalledGapIndex = null
      if (step.type === 'PLANNER_RESPONSE' && step.status && step.status !== 'DONE') {
        break
      }
      if (
        step.type === 'GENERIC' &&
        step.status &&
        step.status !== 'DONE' &&
        step.status !== 'ERROR' &&
        step.status !== 'RUNNING'
      ) {
        break
      }
      this.streamer.processStep(ctx, idx, step)
      this.watcherStepCursor = idx
    }
    this.ledger.reconcile(sessionId, this.reader, this.emitTurn)
    this.streamer.maybeCloseTurn(
      sessionId,
      this.reader,
      this.emitTurn,
      this.options.now?.() ?? Date.now(),
      this.options.reactiveQuietDoneMs
    )
  }

  private refreshDisk(sessionId: string): Promise<void> {
    return this.reader.refresh(this.sysDir(sessionId), (toolCallId) => {
      if (!this.inPrompt && !this.streamer.openPromptTools.has(toolCallId)) {
        this.streamer.settledLauncherCallIds.add(toolCallId)
      }
    })
  }

  private sysDir(sessionId: string): string {
    return join(this.options.geminiHome, 'antigravity-cli', 'brain', sessionId, '.system_generated')
  }

  private readonly emitTurn = (params: unknown): void => {
    this.emit?.('_agy/turn_update', params)
  }

  /** Reset idle backoff and schedule an immediate active poll interval. */
  private resetPollDelay(): void {
    this.idlePollMs = this.options.activePollMs ?? ACTIVE_POLL_MS
    if (!this.disposed && this.sessionId) {
      this.scheduleNextPoll()
    }
  }

  /** Schedule the next transcript poll using active cadence during work and exponential backoff when idle. */
  private scheduleNextPoll(overrideDelayMs?: number): void {
    if (this.disposed || !this.sessionId) {
      return
    }
    const active =
      this.inPrompt || this.ledger.hasWorkingTasks || this.streamer.activeReactiveTurn !== null
    const base = this.options.activePollMs ?? ACTIVE_POLL_MS
    const delay = overrideDelayMs ?? (active ? base : this.idlePollMs)
    if (overrideDelayMs === undefined && !active) {
      this.idlePollMs = Math.min(this.idlePollMs * 2, MAX_IDLE_POLL_MS)
    }
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.pollOnce().finally(() => this.scheduleNextPoll())
    }, delay)
    this.timer.unref?.()
  }
}
