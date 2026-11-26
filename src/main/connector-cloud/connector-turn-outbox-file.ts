// Turn ends wait in an owner-only file so a restart still reports them. Its writes and deletes run in
// order off the main thread, shared by every owner in this process, so a retired account's write
// always lands before the delete that follows it.
import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import {
  CONNECTOR_TURN_ORIGINS,
  ConnectorConversation,
  ConnectorFailure,
  type ConnectorEvent
} from '../../shared/connectors/connector-cloud-contract'
import { ConnectorWorkLink } from '../../shared/connector-work-link-contract'
import { CoalescingFileWriter } from '../filesystem/coalescing-file-writer'
import { removeStaleDurableWriteTempFiles } from '../filesystem/durable-file-write'
import {
  removeStaleOwnerOnlyStaging,
  writeOwnerOnlyFileDurable
} from '../filesystem/owner-only-durable-file-write'
import { isMissingFileError } from '../runtime/rpc/server/pairing/device-registry-corruption'

type TurnEnded = Extract<ConnectorEvent, { kind: 'turn-ended' }>

// Tagged with the account that produced them, so another account never sends them after a relaunch.
const StoredOutbox = lazyZodSchema(() =>
  z.object({
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
        stateOnly: z.literal(true).optional().catch(undefined),
        resumes: z.literal(true).optional().catch(undefined)
      })
    )
  })
)

/** What the file holds; null when there is none. */
type StoredState = { account: string; turnEnds: readonly TurnEnded[] } | null

const files = new Map<string, TurnOutboxFile>()

/** One file's ordered writes and deletes, shared by every owner in this process. */
class TurnOutboxFile {
  private readonly writer = new CoalescingFileWriter<StoredState>((state) => this.commit(state))
  private staleTempsSwept = false

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
    return this.writer.pending
  }

  save(state: StoredState): void {
    this.writer.save(state)
  }

  settled(): Promise<void> {
    return this.writer.settled()
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
