// Kept chats' shared-tool caller tokens, sealed at rest so a chat whose agent outlives the app keeps
// its caller identity. Only the session id, run fence and grant owner are in the clear; the caller
// payload carries the bot and MCP tokens, so it is sealed whole. One entry (and file) per kept chat
// run, so a launch writes only its own.
import {
  relaySealingProtected,
  relayUnlockThrottle,
  type RelayUnlockThrottle,
  sealRelaySecret
} from '../../../bots/tool-relay/relay-sealed-file'
import { RelaySealedEntries } from '../../../bots/tool-relay/relay-sealed-entries'
import {
  keptToolCallerRun,
  keptToolCallerRunsInstalled,
  keptToolCallersPath,
  keptToolGrantsConfig
} from '../../../bots/tool-relay/kept-tool-grants'

import {
  callerKey,
  isStoredCaller,
  opened,
  type KeptSharedToolCaller,
  type StoredSharedToolCaller
} from './kept-shared-tool-caller'

export type { KeptSharedToolCaller, StoredSharedToolCaller }

type Entry = { stored: StoredSharedToolCaller; kept: KeptSharedToolCaller | null }

/** At most this many locked entries are decrypted per retry, so one retry's work stays bounded. */
const UNLOCK_BATCH = 64

export class SharedToolCallerStore {
  private files: RelaySealedEntries<StoredSharedToolCaller> | null = null
  /**
   * Each kept chat's run entries by fence, sealed as written, with what each opened to; null while
   * the keychain won't open it (it stays as written and is retried).
   */
  private readonly chats = new Map<string, Map<number, Entry>>()
  /** The entries still locked, so a lookup that finds nothing to retry does no scan. */
  private readonly locked = new Set<Entry>()
  /** Each owner's seals still running; a revoke marks them, so none writes that owner back. */
  private readonly sealing = new Map<string, Set<{ revoked: boolean }>>()
  /** Told of each kept caller token that retires, so this run stops answering for it. */
  onRetired: (token: string) => void = () => {}
  private loading: Promise<void> | null = null

  constructor(private readonly throttle: RelayUnlockThrottle = relayUnlockThrottle) {}

  /**
   * Opens the entries whose chat's placement still names their run and whose owner's grant is kept;
   * every other entry is dropped from the file. Once per run, and only once both the app data folder
   * and the chat host's runs are known; until then nothing is kept.
   */
  async load(): Promise<void> {
    const config = keptToolGrantsConfig()
    if (!config || !keptToolCallerRunsInstalled()) {
      return
    }
    this.files ??= new RelaySealedEntries(
      keptToolCallersPath(config.directory),
      isStoredCaller,
      callerKey
    )
    this.loading ??= this.loadOnce(this.files)
    return this.loading
  }

  private async loadOnce(files: RelaySealedEntries<StoredSharedToolCaller>): Promise<void> {
    // Loaded when used: the relay's revoke reaches this store.
    const { botToolRelay } = await import('../../../bots/tool-relay/bot-tool-relay')
    await botToolRelay.kept.loaded()
    for (const stored of await files.read()) {
      if (
        keptToolCallerRun(stored.sessionId) === stored.runFence &&
        botToolRelay.kept.keeps(stored.owner)
      ) {
        this.put({ stored, kept: await opened(stored) })
      } else {
        void files.delete(stored).catch(() => {})
      }
    }
  }

  /** Some kept caller is still waiting for the keychain. */
  hasLocked(): boolean {
    return this.locked.size > 0
  }

  /** Every kept caller that opened. */
  opened(): KeptSharedToolCaller[] {
    return [...this.chats.values()].flatMap((runs) =>
      [...runs.values()].flatMap(({ kept }) => (kept ? [kept] : []))
    )
  }

  /**
   * Entries the keychain refused at load, retried at most once per 10 s across every kept relay
   * file; returns the callers that opened now.
   */
  async unlock(): Promise<KeptSharedToolCaller[]> {
    if (this.locked.size === 0 || !this.throttle.due()) {
      return []
    }
    const opening: Entry[] = []
    for (const entry of this.locked) {
      if (opening.push(entry) === UNLOCK_BATCH) {
        break
      }
    }
    const kept: KeptSharedToolCaller[] = []
    for (const entry of opening) {
      if (await this.open(entry)) {
        kept.push(entry.kept!)
      } else if (this.locked.delete(entry)) {
        // Still locked: to the back, so the next retry reaches the entries after it.
        this.locked.add(entry)
      }
    }
    return kept
  }

  /**
   * The chat's kept caller from an earlier run of Orca, if its run is still the current one. Its
   * reattach tries a still-locked entry of its own once, apart from the shared retry.
   */
  async restored(sessionId: string): Promise<KeptSharedToolCaller | null> {
    for (const entry of this.chats.get(sessionId)?.values() ?? []) {
      if (entry.kept || (await this.open(entry))) {
        return entry.kept
      }
    }
    return null
  }

  /** Async: on Linux only the async keychain path recovers once a locked keyring is unlocked. */
  private async open(entry: Entry): Promise<boolean> {
    if (!entry.kept) {
      const kept = await opened(entry.stored)
      // Retired while the keychain answered: it stays gone.
      if (!kept || !this.locked.has(entry)) {
        return entry.kept !== null
      }
      entry.kept = kept
    }
    this.locked.delete(entry)
    return true
  }

  /** Durably keeps a caller; false (memory-only, so its launch is app-bound) when it can't. */
  async keep(caller: KeptSharedToolCaller, resealed?: string): Promise<boolean> {
    // Marked by a revoke of its owner until it lands; tracked only while it runs.
    const pending = { revoked: false }
    const ofOwner = this.sealing.get(caller.owner) ?? new Set()
    this.sealing.set(caller.owner, ofOwner.add(pending))
    try {
      return await this.sealAndKeep(caller, resealed, pending)
    } finally {
      ofOwner.delete(pending)
      if (ofOwner.size === 0 && this.sealing.get(caller.owner) === ofOwner) {
        this.sealing.delete(caller.owner)
      }
    }
  }

  private async sealAndKeep(
    caller: KeptSharedToolCaller,
    resealed: string | undefined,
    pending: { revoked: boolean }
  ): Promise<boolean> {
    await this.load()
    const files = this.files
    if (!files || (resealed === undefined && !relaySealingProtected())) {
      return false
    }
    let sealed: string
    try {
      sealed =
        resealed ??
        (await sealRelaySecret(JSON.stringify({ caller: caller.caller, token: caller.token })))
    } catch {
      return false
    }
    // Its owner was revoked meanwhile: a deleted bot's caller never reaches the file.
    if (pending.revoked) {
      return false
    }
    const { sessionId, runFence, owner } = caller
    const entry: Entry = { stored: { sessionId, runFence, owner, sealed }, kept: caller }
    this.put(entry)
    try {
      await files.put(entry.stored)
      return true
    } catch {
      void this.retire(entry).catch(() => {})
      return false
    }
  }

  /**
   * `current` is the caller the chat's run now uses (null: none kept); every other entry of the
   * chat retires. A reattached run whose kept entry is still locked carries that entry instead.
   */
  async settle(
    sessionId: string,
    current: KeptSharedToolCaller | null,
    carryLockedTo?: number
  ): Promise<void> {
    await this.retireExcept(sessionId, await this.adopt(sessionId, current, carryLockedTo))
  }

  /**
   * Durably writes the run's entry and leaves the chat's others, so a crash before the run's
   * placement is saved still finds the entry the saved placement names. Returns the run's fence.
   */
  async adopt(
    sessionId: string,
    current: KeptSharedToolCaller | null,
    /** A reattached run's fence: a still-locked entry of the chat moves to it. */
    carryLockedTo?: number
  ): Promise<number | undefined> {
    await this.load()
    const runs = [...(this.chats.get(sessionId)?.values() ?? [])]
    const carried =
      carryLockedTo === undefined ? undefined : runs.find((entry) => entry.kept === null)
    if (carried && carryLockedTo !== undefined) {
      // The reattached agent holds that entry's token, so the run's caller is it, not `current`.
      const moved: Entry = { stored: { ...carried.stored, runFence: carryLockedTo }, kept: null }
      this.put(moved)
      try {
        await this.files?.put(moved.stored)
        return carryLockedTo
      } catch {
        // Not durable: the entry the saved placement names stays until one is.
        this.remove(moved)
        return carried.stored.runFence
      }
    }
    if (
      current &&
      this.chats.get(sessionId)?.get(current.runFence)?.kept?.token !== current.token
    ) {
      // A reattached caller is sealed already: its earlier entry's sealing is reused, not redone.
      const earlier = runs.find((entry) => entry.kept?.token === current.token)
      if (!(await this.keep(current, earlier?.stored.sealed)) && earlier) {
        // Not durable: the earlier entry stays until one is.
        return earlier.stored.runFence
      }
    }
    return current?.runFence
  }

  /** Every entry of the chat but the run at `fence` retires. */
  async retireExcept(sessionId: string, fence: number | undefined): Promise<void> {
    await this.load()
    const going = [...(this.chats.get(sessionId)?.values() ?? [])].filter(
      (entry) => entry.stored.runFence !== fence
    )
    await Promise.all(going.map((entry) => this.retire(entry).catch(() => {})))
  }

  /** Removes exactly this entry (its launch failed); other runs of the chat stay. */
  async drop(caller: KeptSharedToolCaller): Promise<void> {
    await this.load()
    const entry = this.chats.get(caller.sessionId)?.get(caller.runFence)
    if (entry?.kept === caller) {
      await this.retire(entry)
    }
  }

  /** The owner's grant is being revoked: its callers go durably first. */
  async forgetOwner(owner: string): Promise<void> {
    for (const pending of this.sealing.get(owner) ?? []) {
      pending.revoked = true
    }
    await this.load()
    const going = [...this.chats.values()].flatMap((runs) =>
      [...runs.values()].filter((entry) => entry.stored.owner === owner)
    )
    await Promise.all(going.map((entry) => this.retire(entry)))
  }

  /** The entry leaves memory, then its file; a replaced entry's file is its replacement's. */
  private retire(entry: Entry): Promise<void> {
    if (!this.remove(entry)) {
      return Promise.resolve()
    }
    const token = entry.kept?.token
    const stillUsed = [...(this.chats.get(entry.stored.sessionId)?.values() ?? [])].some(
      (other) => other.kept?.token === token
    )
    if (token !== undefined && !stillUsed) {
      this.onRetired(token)
    }
    return this.files?.delete(entry.stored) ?? Promise.resolve()
  }

  private put(entry: Entry): void {
    const { sessionId, runFence } = entry.stored
    const runs = this.chats.get(sessionId) ?? new Map<number, Entry>()
    const replaced = runs.get(runFence)
    if (replaced) {
      this.locked.delete(replaced)
    }
    runs.set(runFence, entry)
    this.chats.set(sessionId, runs)
    if (entry.kept === null) {
      this.locked.add(entry)
    }
  }

  /** True when the entry was still the chat run's. */
  private remove(entry: Entry): boolean {
    const runs = this.chats.get(entry.stored.sessionId)
    this.locked.delete(entry)
    if (runs?.get(entry.stored.runFence) !== entry) {
      return false
    }
    runs.delete(entry.stored.runFence)
    if (runs.size === 0) {
      this.chats.delete(entry.stored.sessionId)
    }
    return true
  }
}

export const sharedToolCallerStore = new SharedToolCallerStore()

/** A deleted chat's kept callers go, from the files and from what this run answers for. */
export function forgetKeptSharedToolChat(sessionId: string): void {
  void sharedToolCallerStore.retireExcept(sessionId, undefined).catch(() => {})
}

export function forgetKeptSharedToolCallers(owner: string): Promise<void> {
  return sharedToolCallerStore.forgetOwner(owner)
}
