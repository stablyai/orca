// When the share list is read next: the timed read (none while the invite wake is up and nothing is
// pairing or held), and the reads a wake asks for, spread so many desktops never read at once.
import type { InviteWake, InviteWakeEvent } from '../../connector-cloud/connector-invite-wake'

// A share-change wake reads within this, spread so one change to many accounts isn't one burst.
const SHARES_CHANGED_SPREAD_MS = 2_000
// A reopened wake socket reads once within this (reconnect waves reopen thousands together), unless
// the list was read within the skip.
const REOPEN_READ_SPREAD_MS = 60_000
const REOPEN_READ_SKIP_MS = 10 * 60_000

export type SharedBotReadPaceDeps = {
  /** The share list's wake; while it is up the idle read waits for it instead of a timer. */
  invites?: Pick<InviteWake, 'up' | 'listen'> | null
  /** The timed read's delay, or null for none, given whether the wake is up. */
  nextReadMs: (woken: boolean) => number | null
  read: () => void
  now: () => number
  random?: () => number
}

export class SharedBotReadPace {
  private timer: ReturnType<typeof setTimeout> | null = null
  // A read a wake asked for, due once its spread passes, and when it was asked for.
  private wakeRead: {
    timer: ReturnType<typeof setTimeout>
    dueAt: number
    askedAt: number
  } | null = null
  // When the last read began (it covers any wake before it), and when one last got an answer.
  private lastReadAt = Number.NEGATIVE_INFINITY
  private lastAnsweredAt = Number.NEGATIVE_INFINITY
  private stopped = false

  constructor(private readonly deps: SharedBotReadPaceDeps) {
    deps.invites?.listen((event) => this.woke(event))
  }

  start(): void {
    this.stopped = false
  }

  stop(): void {
    this.stopped = true
    this.clearTimer()
    if (this.wakeRead) {
      clearTimeout(this.wakeRead.timer)
      this.wakeRead = null
    }
  }

  /** A read begins: it stands for the timed one. */
  began(): void {
    this.clearTimer()
    this.lastReadAt = this.deps.now()
  }

  /** A read settled; only one the cloud answered makes a catch-up read needless. */
  settled(answered: boolean): void {
    if (answered) {
      this.lastAnsweredAt = this.lastReadAt
    }
    this.schedule()
  }

  /** Sets the next timed read, if any. */
  schedule(): void {
    this.clearTimer()
    if (this.stopped) {
      return
    }
    const waitMs = this.deps.nextReadMs(this.deps.invites?.up ?? false)
    if (waitMs !== null) {
      this.timer = setTimeout(() => this.deps.read(), waitMs)
      this.timer.unref?.()
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private woke(event: InviteWakeEvent): void {
    if (this.stopped) {
      return
    }
    if (event !== 'shares-changed') {
      // Up, the idle read stops; down, it resumes.
      this.schedule()
    }
    if (event === 'closed') {
      return
    }
    const now = this.deps.now()
    // Wakes sent while it was down are lost: one read catches up, unless one just did.
    if (event === 'opened' && now - this.lastAnsweredAt < REOPEN_READ_SKIP_MS) {
      return
    }
    const spread = event === 'opened' ? REOPEN_READ_SPREAD_MS : SHARES_CHANGED_SPREAD_MS
    const dueAt = now + (this.deps.random ?? Math.random)() * spread
    const asked = this.wakeRead
    // The newest wake is the one a read must begin after.
    if (asked && asked.dueAt <= dueAt) {
      asked.askedAt = now
      return
    }
    if (asked) {
      clearTimeout(asked.timer)
    }
    const wakeRead = {
      dueAt,
      askedAt: now,
      timer: setTimeout(() => {
        this.wakeRead = null
        // A read that began after the newest wake already covers it.
        if (this.lastReadAt < wakeRead.askedAt) {
          this.deps.read()
        }
      }, dueAt - now)
    }
    wakeRead.timer.unref?.()
    this.wakeRead = wakeRead
  }
}
