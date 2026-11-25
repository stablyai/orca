/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Generic throttled flush controller.
 *
 * A pure scheduling primitive that manages timer-based throttling,
 * mutex-guarded flushing, and reflush-on-conflict. Contains no
 * business logic — the actual flush work is provided via a callback.
 */

import { THROTTLE_CONSTANTS } from './streaming-constants'

// ---------------------------------------------------------------------------
// FlushController
// ---------------------------------------------------------------------------

export class FlushController {
  private flushInProgress = false
  private flushResolvers: (() => void)[] = []
  private needsReflush = false
  private pendingFlushTimer: ReturnType<typeof setTimeout> | null = null
  private lastUpdateTime = 0
  private isCompleted = false

  constructor(private readonly doFlush: () => Promise<void>) {}

  /** Mark the controller as completed — no more flushes after current one. */
  complete(): void {
    this.isCompleted = true
  }

  /** Cancel any pending deferred flush timer. */
  cancelPendingFlush(): void {
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer)
      this.pendingFlushTimer = null
    }
  }

  /** Wait for any in-progress flush to finish. */
  waitForFlush(): Promise<void> {
    if (!this.flushInProgress) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => this.flushResolvers.push(resolve))
  }

  /**
   * Execute a flush (mutex-guarded, with reflush on conflict).
   *
   * If a flush is already in progress, marks needsReflush so a
   * follow-up flush fires immediately after the current one completes.
   */
  async flush(): Promise<void> {
    if (!this.cardMessageReady() || this.flushInProgress || this.isCompleted) {
      if (this.flushInProgress && !this.isCompleted) {
        this.needsReflush = true
      }
      return
    }
    this.flushInProgress = true
    this.needsReflush = false
    // Update timestamp BEFORE the API call to prevent concurrent callers
    // from also entering the flush (race condition fix).
    this.lastUpdateTime = Date.now()
    try {
      await this.doFlush()
      this.lastUpdateTime = Date.now()
    } finally {
      this.flushInProgress = false
      const resolvers = this.flushResolvers
      this.flushResolvers = []
      for (const resolve of resolvers) {
        resolve()
      }

      // If events arrived while the API call was in flight,
      // schedule an immediate follow-up flush.
      if (this.needsReflush && !this.isCompleted && !this.pendingFlushTimer) {
        this.needsReflush = false
        this.pendingFlushTimer = setTimeout(() => {
          this.pendingFlushTimer = null
          void this.flush()
        }, 0)
      }
    }
  }

  /**
   * Throttled update entry point.
   *
   * @param throttleMs - Minimum interval between flushes (varies by
   *   CardKit vs IM patch mode). Passed in by the caller so this
   *   controller remains business-logic-free.
   */
  async throttledUpdate(throttleMs: number): Promise<void> {
    if (!this.cardMessageReady()) {
      return
    }

    const now = Date.now()
    const elapsed = now - this.lastUpdateTime

    if (elapsed >= throttleMs) {
      this.cancelPendingFlush()
      if (elapsed > THROTTLE_CONSTANTS.LONG_GAP_THRESHOLD_MS) {
        // After a long gap, batch briefly so the first visible update
        // contains meaningful text rather than just 1-2 characters.
        this.lastUpdateTime = now
        this.pendingFlushTimer = setTimeout(() => {
          this.pendingFlushTimer = null
          void this.flush()
        }, THROTTLE_CONSTANTS.BATCH_AFTER_GAP_MS)
      } else {
        await this.flush()
      }
    } else if (!this.pendingFlushTimer) {
      // Inside throttle window — schedule a deferred flush
      const delay = throttleMs - elapsed
      this.pendingFlushTimer = setTimeout(() => {
        this.pendingFlushTimer = null
        void this.flush()
      }, delay)
    }
  }

  // ------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------

  /** Overridable gate: subclasses / consumers can set via setCardMessageReady. */
  private _cardMessageReady = false

  cardMessageReady(): boolean {
    return this._cardMessageReady
  }

  setCardMessageReady(ready: boolean): void {
    this._cardMessageReady = ready
    if (ready) {
      // Initialize the timestamp so the first throttledUpdate sees a
      // small elapsed time (matching original behavior where
      // lastCardUpdateTime = Date.now() was set during card creation).
      this.lastUpdateTime = Date.now()
    }
  }
}
