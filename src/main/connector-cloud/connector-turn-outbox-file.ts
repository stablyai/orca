// Turn ends wait in an owner-only file so a restart still reports them. Its writes and deletes run in
// order off the main thread, shared by every owner in this process, so a retired account's write
// always lands before the delete that follows it.
import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
  CONNECTOR_TURN_ORIGINS,
  ConnectorConversation,
  ConnectorFailure,
  type ConnectorEvent
} from '../../shared/connectors/connector-cloud-contract'
import { ConnectorWorkLink } from '../../shared/connector-work-link-contract'
import { removeStaleDurableWriteTempFiles } from '../filesystem/durable-file-write'
import {
  removeStaleOwnerOnlyStaging,
  writeOwnerOnlyFileDurable
} from '../filesystem/owner-only-durable-file-write'
import { isMissingFileError } from '../runtime/rpc/server/pairing/device-registry-corruption'

type TurnEnded = Extract<ConnectorEvent, { kind: 'turn-ended' }>

// Tagged with the account that produced them, so another account never sends them after a relaunch.
const StoredOutbox = z.object({
  account: z.string().min(1),
  turnEnds: z.array(
    z.object({
      kind: z.literal('turn-ended'),
      conversation: ConnectorConversation,
      paneKey: z.string().min(1),
      turnId: z.number(),
      at: z.number(),
      stopReason: z.string().min(1).nullable(),
      lastAssistantMessage: z.string().optional(),
      origin: z.enum(CONNECTOR_TURN_ORIGINS).optional(),
      failure: ConnectorFailure.optional().catch(undefined),
      links: z.array(ConnectorWorkLink).optional().catch(undefined),
      mirror: z.literal(true).optional().catch(undefined),
      stateOnly: z.literal(true).optional().catch(undefined)
    })
  )
})

/** What the file holds; null when there is none. */
type StoredState = { account: string; turnEnds: readonly TurnEnded[] } | null

const RETRY_MIN_MS = 1_000
const RETRY_MAX_MS = 30_000

const files = new Map<string, TurnOutboxFile>()

/** One write or delete at a time; while it runs, only the newest state waits behind it. */
class TurnOutboxFile {
  // The newest state not yet on disk; undefined once the file holds it.
  private wanted: StoredState | undefined
  // Bumped by every save, so a drain sees a newer state arrived while it wrote.
  private generation = 0
  private running: Promise<void> | null = null
  private staleTempsSwept = false
  // Ends a retry's wait early: a new save tries at once, and quit tries once more.
  private wake: (() => void) | null = null
  // Settling for quit: a failure ends the drain rather than wait out a backoff, once an attempt
  // started after quit began (numbered past `quitFrom`) has failed too.
  private quitting = false
  private attempts = 0
  private quitFrom = 0
  // The last drain stopped on a failure while quitting; only a new save starts another.
  private gaveUp = false

  constructor(readonly path: string) {}

  static at(path: string): TurnOutboxFile {
    let file = files.get(path)
    if (!file) {
      file = new TurnOutboxFile(path)
      files.set(path, file)
    }
    return file
  }

  /** What a new owner must read instead of the file while it hasn't landed. */
  get pending(): StoredState | undefined {
    return this.wanted
  }

  save(state: StoredState): void {
    this.wanted = state
    this.generation += 1
    this.gaveUp = false
    this.wake?.()
    this.run()
  }

  private run(): void {
    this.running ??= this.drain().finally(() => {
      this.running = null
      // A save that came in as the drain finished.
      if (this.wanted !== undefined && !this.gaveUp) {
        this.run()
      }
    })
  }

  /** For quit: what is queued lands, and a failing save gets one more try instead of its backoff. */
  async settled(): Promise<void> {
    this.quitting = true
    this.quitFrom = this.attempts
    try {
      this.wake?.()
      if (this.wanted !== undefined) {
        this.gaveUp = false
        this.run()
      }
      while (this.running) {
        await this.running
      }
    } finally {
      this.quitting = false
    }
  }

  private async drain(): Promise<void> {
    let retryMs = 0
    while (this.wanted !== undefined) {
      const { wanted, generation } = this
      const attempt = ++this.attempts
      const landed = await this.commit(wanted)
      if (generation !== this.generation) {
        continue
      }
      if (landed) {
        this.wanted = undefined
        return
      }
      // Kept wanted, so no later owner in this process reads the stale file.
      if (this.quitting) {
        if (attempt > this.quitFrom) {
          this.gaveUp = true
          return
        }
        continue
      }
      retryMs = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, retryMs * 2))
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, retryMs)
        this.wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      this.wake = null
    }
  }

  private async commit(state: StoredState): Promise<boolean> {
    try {
      if (!this.staleTempsSwept) {
        this.staleTempsSwept = true
        // A quit cut off mid-write leaves its staged file; only other processes' are taken.
        await removeStaleDurableWriteTempFiles(this.path)
        await removeStaleOwnerOnlyStaging(dirname(this.path))
      }
      if (state === null) {
        await rm(this.path, { force: true })
        return true
      }
      // Never cut short by a newer save: under steady changes every write still lands, newest next.
      await writeOwnerOnlyFileDurable(this.path, JSON.stringify(state))
      return true
    } catch (error) {
      console.warn('[connector] could not save pending turn ends', error)
      return false
    }
  }
}

// The outbox never copies an event, so the same turn ends in the same order are the same objects.
const sameTurnEnds = (a: readonly TurnEnded[], b: readonly TurnEnded[] | undefined): boolean =>
  b !== undefined && a.length === b.length && a.every((event, index) => event === b[index])

/** One account's pending turn ends on disk, saved only when they change. */
export class ConnectorTurnEndFile {
  private readonly file: TurnOutboxFile
  // The turn ends last saved; undefined when unknown, so the next save always lands.
  private saved: readonly TurnEnded[] | undefined
  // Cleared for a sign-out or another account: nothing it does reaches the file again.
  private retired = false

  constructor(
    path: string,
    private readonly account: string
  ) {
    this.file = TurnOutboxFile.at(path)
  }

  /** Every queued save in this process, landed; for quit. */
  static async settled(): Promise<void> {
    await Promise.all([...files.values()].map((file) => file.settled()))
  }

  /** Drops whatever the file holds, before any owner exists in this process. */
  static clearAt(path: string): void {
    TurnOutboxFile.at(path).save(null)
  }

  /** This account's turn ends, as queued work will leave the file. */
  read(): TurnEnded[] {
    const pending = this.file.pending
    const turnEnds = pending === undefined ? this.readFile() : this.ownPending(pending)
    this.saved = turnEnds && [...turnEnds]
    return turnEnds ?? []
  }

  save(turnEnds: readonly TurnEnded[]): void {
    if (this.retired || sameTurnEnds(turnEnds, this.saved)) {
      return
    }
    this.saved = turnEnds
    this.file.save(turnEnds.length === 0 ? null : { account: this.account, turnEnds })
  }

  clear(): void {
    this.retired = true
    this.file.save(null)
  }

  /** Undefined when the file is another account's or unreadable. */
  private readFile(): TurnEnded[] | undefined {
    let raw: string
    try {
      raw = readFileSync(this.file.path, 'utf8')
    } catch (error) {
      if (isMissingFileError(error)) {
        return []
      }
      throw error
    }
    try {
      const parsed = StoredOutbox.safeParse(JSON.parse(raw))
      return parsed.success && parsed.data.account === this.account
        ? parsed.data.turnEnds
        : undefined
    } catch {
      return undefined
    }
  }

  // Already validated: the same objects, so an unchanged list stays unchanged.
  private ownPending(pending: StoredState): TurnEnded[] | undefined {
    if (pending === null) {
      return []
    }
    return pending.account === this.account ? [...pending.turnEnds] : undefined
  }
}
