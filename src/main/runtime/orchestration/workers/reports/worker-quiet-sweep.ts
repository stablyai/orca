export type WorkerQuietObservation = {
  dispatchId: string
  turnStartedAt: number
  working: boolean
  restoredUnconfirmed?: boolean
  connected?: boolean
  connectionId?: string | null
  workingSince?: number
  lastProducerEventAt?: number
  progressObservable?: boolean
  tool?: { name: string; startedAt: number }
}

export type QuietNotice = {
  dispatchId: string
  turnStartedAt: number
  ordinal: number
  observedAt: number
  intervalMs: number
}

type Episode = {
  turn: number
  progress?: number
  connected: boolean
  connectionId?: string | null
  grace: number
  firstNoticeAt?: number
  notices: number
  ordinal: number
  previous?: QuietNotice
}

const SWEEP_MS = 60_000

/** Observations never authorize an action on the worker; only a rate-limited advisory. */
export class WorkerQuietSweep {
  private readonly episodes = new Map<string, Episode>()
  private readonly history = new Map<string, QuietNotice | undefined>()
  private readonly recovered = new Set<string>()
  private lastSweepAt: number
  private resumedAt: number

  constructor(
    private readonly startedAt: number,
    private readonly latest: (dispatchIds: readonly string[]) => ReadonlyMap<string, QuietNotice>,
    private readonly send: (observation: WorkerQuietObservation, notice: QuietNotice) => boolean
  ) {
    this.lastSweepAt = startedAt
    this.resumedAt = startedAt
  }

  resume(now: number): void {
    for (const episode of this.episodes.values()) {
      this.pauseReminder(episode, now - this.lastSweepAt)
    }
    this.lastSweepAt = now
    this.resumedAt = now
  }

  private pauseReminder(episode: Episode, elapsed: number): void {
    if (episode.firstNoticeAt !== undefined) {
      episode.firstNoticeAt += elapsed
    }
    if (episode.previous) {
      episode.previous = { ...episode.previous, observedAt: episode.previous.observedAt + elapsed }
    }
  }

  sweep(observations: WorkerQuietObservation[], now: number, openDispatchIds?: string[]): void {
    const gap = now - this.lastSweepAt
    if (gap < 0 || gap > SWEEP_MS * 3) {
      this.resume(now)
    }
    const elapsed = now - this.lastSweepAt
    this.lastSweepAt = now
    const observed = new Set(observations.map((row) => row.dispatchId))
    const open = openDispatchIds ? new Set(openDispatchIds) : observed
    for (const id of this.episodes.keys()) {
      if (!observed.has(id)) {
        this.episodes.delete(id)
      }
    }
    for (const id of this.history.keys()) {
      if (!open.has(id)) {
        this.history.delete(id)
        this.recovered.delete(id)
      }
    }
    const unrecovered = observations.filter(
      (row) => row.working && !row.restoredUnconfirmed && !this.history.has(row.dispatchId)
    )
    if (unrecovered.length > 0) {
      const latest = this.latest(unrecovered.map((row) => row.dispatchId))
      for (const row of unrecovered) {
        const previous = latest.get(row.dispatchId)
        this.history.set(row.dispatchId, previous)
        if (previous) {
          this.recovered.add(row.dispatchId)
        }
      }
    }
    for (const row of observations) {
      if (!row.working || row.restoredUnconfirmed) {
        this.episodes.delete(row.dispatchId)
        continue
      }
      let episode = this.episodes.get(row.dispatchId)
      const connected = row.connected !== false
      if (episode && (!episode.connected || !connected)) {
        this.pauseReminder(episode, elapsed)
      }
      if (!episode || episode.turn !== row.turnStartedAt) {
        const previous = this.history.get(row.dispatchId)
        const recovered =
          this.recovered.has(row.dispatchId) &&
          previous?.turnStartedAt === row.turnStartedAt &&
          previous.observedAt >= (row.lastProducerEventAt ?? -Infinity)
        if (!recovered) {
          this.recovered.delete(row.dispatchId)
        }
        episode = {
          turn: row.turnStartedAt,
          progress: row.lastProducerEventAt ?? row.workingSince,
          connectionId: row.connectionId,
          connected,
          grace: row.lastProducerEventAt === undefined ? now : this.startedAt,
          notices: recovered ? 1 : 0,
          ordinal: previous?.turnStartedAt === row.turnStartedAt ? previous.ordinal : 0,
          previous: recovered ? previous : undefined
        }
        this.episodes.set(row.dispatchId, episode)
      }
      if (episode.progress !== (row.lastProducerEventAt ?? row.workingSince)) {
        episode.progress = row.lastProducerEventAt ?? row.workingSince
        episode.notices = 0
        episode.firstNoticeAt = undefined
        // A new observed episode can notify normally, even if an older episode notified recently.
        episode.previous = undefined
        this.recovered.delete(row.dispatchId)
      }
      if ((!episode.connected && connected) || episode.connectionId !== row.connectionId) {
        episode.grace = now
      }
      episode.connectionId = row.connectionId
      episode.connected = connected
      if (!connected || episode.notices >= 2) {
        continue
      }
      const since = Math.max(
        row.lastProducerEventAt ?? episode.grace,
        row.turnStartedAt,
        row.workingSince ?? 0,
        this.startedAt,
        this.resumedAt,
        episode.grace
      )
      const interval = row.tool || row.lastProducerEventAt === undefined ? 3_600_000 : 900_000
      if (now - since < interval) {
        continue
      }
      if (episode.firstNoticeAt !== undefined && now - episode.firstNoticeAt < interval * 2) {
        continue
      }
      if (episode.previous && now - episode.previous.observedAt < episode.previous.intervalMs * 2) {
        continue
      }
      const notice: QuietNotice = {
        dispatchId: row.dispatchId,
        turnStartedAt: row.turnStartedAt,
        ordinal: episode.ordinal + 1,
        observedAt: now,
        intervalMs: interval
      }
      if (this.send(row, notice)) {
        episode.ordinal = notice.ordinal
        episode.notices++
        episode.firstNoticeAt ??= now
        episode.previous = undefined
        this.history.set(row.dispatchId, notice)
        this.recovered.delete(row.dispatchId)
      }
    }
  }
}
