type DaemonPtyIncarnationFlagName = 'inputClosed' | 'startupLaunchTyped'

type DaemonPtyIncarnationFlagResult = { isNew: boolean; incarnationId?: string } & Partial<
  Record<DaemonPtyIncarnationFlagName, true>
>

/** Incarnations a daemon-reported fact holds for; a report can land before its spawn reply. */
class DaemonPtyIncarnationFlag {
  private readonly flaggedBySession = new Map<string, Set<string>>()

  constructor(
    private readonly flag: DaemonPtyIncarnationFlagName,
    private readonly onRecorded?: (sessionId: string, incarnationId: string) => void
  ) {}

  /** False when this incarnation already carried the fact. */
  record(sessionId: string, incarnationId: string): boolean {
    const flagged = this.flaggedBySession.get(sessionId) ?? new Set<string>()
    if (flagged.has(incarnationId)) {
      return false
    }
    flagged.add(incarnationId)
    this.flaggedBySession.set(sessionId, flagged)
    this.onRecorded?.(sessionId, incarnationId)
    return true
  }

  /** A spawn reply names the live incarnation; facts about any other one no longer apply. */
  sync(sessionId: string, result: DaemonPtyIncarnationFlagResult): void {
    if (!result.incarnationId) {
      if (result.isNew) {
        this.flaggedBySession.delete(sessionId)
      }
      return
    }
    if (result[this.flag]) {
      this.record(sessionId, result.incarnationId)
    }
    if (this.flaggedBySession.get(sessionId)?.has(result.incarnationId)) {
      this.flaggedBySession.set(sessionId, new Set([result.incarnationId]))
    } else {
      this.flaggedBySession.delete(sessionId)
    }
  }

  has(sessionId: string, currentIncarnationId: string | undefined): boolean {
    const flagged = this.flaggedBySession.get(sessionId)
    if (!flagged) {
      return false
    }
    return currentIncarnationId === undefined ? flagged.size > 0 : flagged.has(currentIncarnationId)
  }

  delete(sessionId: string): void {
    this.flaggedBySession.delete(sessionId)
  }
}

/** Per-incarnation facts the daemon reports about its sessions. */
export class DaemonPtyIncarnationFlags {
  readonly inputClosed = new DaemonPtyIncarnationFlag('inputClosed')
  readonly startupLaunchTyped: DaemonPtyIncarnationFlag

  // Fires once per incarnation whether the stream event or a later attach reply reports it first.
  constructor(onStartupLaunchTyped: (sessionId: string, incarnationId: string) => void) {
    this.startupLaunchTyped = new DaemonPtyIncarnationFlag(
      'startupLaunchTyped',
      onStartupLaunchTyped
    )
  }

  sync(sessionId: string, result: DaemonPtyIncarnationFlagResult): void {
    this.inputClosed.sync(sessionId, result)
    this.startupLaunchTyped.sync(sessionId, result)
  }

  delete(sessionId: string): void {
    this.inputClosed.delete(sessionId)
    this.startupLaunchTyped.delete(sessionId)
  }
}
