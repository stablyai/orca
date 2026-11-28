/** The orchestrator's hold on its sidecar: nothing moves on its own or saves before it is read. */
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import { wslMoveJournalKey } from '../../../../shared/wsl-move/wsl-move-cutover'
import type { WslMoveOrchestratorRecord } from '../../../../shared/wsl-move/wsl-move-orchestrator-types'
import type { WslMoveOrchestratorPorts } from './wsl-move-orchestrator-ports'
import { readWslMoveFinishedMove } from './wsl-move-orchestrator-step'
import {
  newWslMoveOrchestratorRecord,
  sameWslMoveOrchestratorRecord,
  withWslMoveOrchestratorState
} from './wsl-move-orchestrator-transitions'

/** Waits before re-trying a save a sharing violation refused (another process held the file). */
export const WSL_MOVE_SIDECAR_SAVE_RETRY_MS = [50, 250, 1_000] as const

type Records = Map<string, WslMoveOrchestratorRecord>
type Replay = (record: WslMoveOrchestratorRecord) => WslMoveOrchestratorRecord

function isTransientSaveError(error: unknown): boolean {
  const code = errnoCodeOrUnknown(error)
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
}

export class WslMoveOrchestratorSidecar {
  private loaded = false
  /** After an unparseable file was set aside, every distro waits until the installed ones are listed. */
  private awaitingList = false
  /** Distros whose record only a newer build can parse: automatic steps leave them alone. */
  private readonly unknown = new Set<string>()
  private readonly releasedByUser = new Set<string>()
  /** What the user did before the file was read, replayed onto its records once it is. */
  private readonly replays = new Map<string, Replay[]>()
  private listing = false
  private saveRetries = 0
  private cancelRetry: (() => void) | null = null

  constructor(
    private readonly ports: Pick<
      WslMoveOrchestratorPorts,
      | 'load'
      | 'save'
      | 'schedule'
      | 'listKnownDistros'
      | 'isDistroInUse'
      | 'finishedMove'
      | 'now'
      | 'appVersion'
    >
  ) {}

  get isLoaded(): boolean {
    return this.loaded
  }

  /** Merges the file into `records` once readable; false while it is not (or already was). */
  tryAdopt(records: Records, settle: Replay): boolean {
    if (this.loaded) {
      return false
    }
    const result = this.ports.load()
    if (result.kind === 'unreadable') {
      return false
    }
    this.loaded = true
    if (result.kind === 'missing') {
      return true
    }
    this.awaitingList = result.holdDistrosOnceListed === true
    for (const key of result.unknownKeys) {
      if (!this.releasedByUser.has(key)) {
        this.unknown.add(key)
      }
    }
    for (const [key, record] of result.records) {
      // Not the user's fresh record: their acts land on the file's, keeping what they did not decide.
      const merged = (this.replays.get(key) ?? []).reduce(
        (next, replay) => replay(next),
        settle(record)
      )
      const current = records.get(key)
      // Same content keeps the object, so a user step under way does not read it as changed under it.
      if (!current || !sameWslMoveOrchestratorRecord(current, merged)) {
        records.set(key, merged)
      }
    }
    this.replays.clear()
    return true
  }

  /** Remembers an act made before the file was read; no-op once it was. */
  noteWhileUnread(key: string, replay: Replay): void {
    if (!this.loaded) {
      this.replays.set(key, [...(this.replays.get(key) ?? []), replay])
    }
  }

  holdsAutomaticSteps(key: string): boolean {
    return (
      !this.loaded || this.unknown.has(key) || (this.awaitingList && !this.releasedByUser.has(key))
    )
  }

  get isAwaitingDistroList(): boolean {
    return this.awaitingList
  }

  /** Holds each installed distro with Orca projects and no record; later ones move normally. */
  holdListedDistros(records: Records, alive: () => boolean): Promise<boolean> | null {
    if (!this.awaitingList || this.listing) {
      return null
    }
    this.listing = true
    return this.holdListed(records, alive).finally(() => {
      this.listing = false
    })
  }

  private async holdListed(records: Records, alive: () => boolean): Promise<boolean> {
    const distros = await this.ports.listKnownDistros().catch(() => null)
    if (!distros) {
      return false
    }
    for (const distro of distros) {
      const key = wslMoveJournalKey(distro)
      const held = await this.heldRecordFor(distro)
      if (!alive() || !this.awaitingList) {
        return false
      }
      if (held && !records.has(key) && !this.releasedByUser.has(key)) {
        records.set(key, held)
      }
    }
    this.awaitingList = false
    return true
  }

  /** A finished move comes back as `done`; any other distro with Orca projects waits for the user. */
  private async heldRecordFor(distro: string): Promise<WslMoveOrchestratorRecord | null> {
    // A failed check holds: wrongly holding costs a click, wrongly moving undoes a decline.
    const inUse = await Promise.resolve()
      .then(() => this.ports.isDistroInUse(distro))
      .catch(() => true)
    if (!inUse) {
      return null
    }
    const now = this.ports.now()
    const fresh = newWslMoveOrchestratorRecord(distro, this.ports.appVersion, now)
    const move = readWslMoveFinishedMove(this.ports, distro)
    if (move !== null && move !== 'unknown') {
      return withWslMoveOrchestratorState(
        fresh,
        { kind: 'done', migrationId: move.migrationId },
        now
      )
    }
    // `released-here`, which older builds accept as a decline; only the copy reads `stateLost`.
    const held = {
      kind: 'parked',
      reason: 'declined',
      cause: 'released-here',
      stateLost: true
    } as const
    return withWslMoveOrchestratorState(fresh, held, now)
  }

  /** The user acted on the distro, which ends any hold on it. */
  release(key: string): void {
    this.unknown.delete(key)
    this.releasedByUser.add(key)
  }

  /** `records` is the live map, so a retried save writes whatever is current by then. */
  save(records: ReadonlyMap<string, WslMoveOrchestratorRecord>): void {
    if (!this.loaded) {
      return
    }
    this.cancelRetryNow()
    try {
      this.ports.save(records, this.awaitingList)
      this.saveRetries = 0
    } catch (error) {
      const delay = WSL_MOVE_SIDECAR_SAVE_RETRY_MS[this.saveRetries]
      if (isTransientSaveError(error) && delay !== undefined) {
        this.saveRetries++
        this.cancelRetry = this.ports.schedule(delay, () => {
          this.cancelRetry = null
          this.save(records)
        })
        return
      }
      this.saveRetries = 0
      // The sidecar is the orchestrator's memory, not the move's record: keep going in memory.
      console.warn('[wsl-move] Orchestrator state not saved:', error)
    }
  }

  /** Cancels a pending save retry, so it cannot overwrite a later orchestrator's file. */
  cancelRetryNow(): void {
    this.cancelRetry?.()
    this.cancelRetry = null
  }
}
