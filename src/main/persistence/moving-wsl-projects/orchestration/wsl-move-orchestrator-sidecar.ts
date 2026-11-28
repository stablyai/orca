/** The orchestrator's hold on its sidecar: nothing moves on its own or saves before it is read. */
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import { wslMoveJournalKey } from '../../../../shared/wsl-move/wsl-move-cutover'
import type { WslMoveOrchestratorRecord } from '../../../../shared/wsl-move/wsl-move-orchestrator-types'
import type { WslMoveOrchestratorPorts } from './wsl-move-orchestrator-ports'
import { applyWslMoveReleasedByUser } from './wsl-move-orchestrator-external-transitions'
import {
  newWslMoveOrchestratorRecord,
  sameWslMoveOrchestratorRecord
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
      'load' | 'save' | 'schedule' | 'listKnownDistros' | 'now' | 'appVersion'
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

  /** Parks each installed distro without a record (Move releases it); later ones move normally. */
  holdListedDistros(records: Records, alive: () => boolean): Promise<boolean> | null {
    if (!this.awaitingList || this.listing) {
      return null
    }
    this.listing = true
    return this.ports
      .listKnownDistros()
      .catch(() => null)
      .then((distros) => {
        this.listing = false
        if (!distros || !alive() || !this.awaitingList) {
          return false
        }
        const now = this.ports.now()
        for (const distro of distros) {
          const key = wslMoveJournalKey(distro)
          if (!records.has(key) && !this.releasedByUser.has(key)) {
            const fresh = newWslMoveOrchestratorRecord(distro, this.ports.appVersion, now)
            records.set(key, applyWslMoveReleasedByUser(fresh, now, 'state-lost'))
          }
        }
        this.awaitingList = false
        return true
      })
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
