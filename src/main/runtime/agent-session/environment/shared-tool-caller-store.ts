// Kept chats' shared-tool caller tokens, sealed at rest so a chat whose agent outlives the app keeps
// its caller identity. Only the session id, run fence and grant owner are in the clear; the caller
// payload carries the bot and MCP tokens, so it is sealed whole. One entry (and file) per kept chat
// run, so a launch writes only its own.
import { jsonObject } from '../../../../shared/json-stream/json-value-property'
import {
  relaySealingProtected,
  relayUnlockThrottle,
  type RelayUnlockThrottle,
  sealRelaySecret,
  unsealRelaySecret
} from '../../../bots/tool-relay/relay-sealed-file'
import { RelaySealedEntries } from '../../../bots/tool-relay/relay-sealed-entries'
import {
  keptToolCallerRun,
  keptToolCallerRunsInstalled,
  keptToolCallersPath,
  keptToolGrantsConfig
} from '../../../bots/tool-relay/kept-tool-grants'

export type StoredSharedToolCaller = {
  sessionId: string
  runFence: number
  owner: string
  sealed: string
}

/** A kept caller as this run holds it. */
export type KeptSharedToolCaller = {
  sessionId: string
  runFence: number
  owner: string
  caller: Readonly<Record<string, string>>
  token: string
}

function isStoredCaller(value: unknown): value is StoredSharedToolCaller {
  const entry = jsonObject(value)
  return (
    entry !== null &&
    typeof entry.sessionId === 'string' &&
    typeof entry.runFence === 'number' &&
    Number.isSafeInteger(entry.runFence) &&
    typeof entry.owner === 'string' &&
    typeof entry.sealed === 'string'
  )
}

const callerKey = (entry: StoredSharedToolCaller): string => `${entry.sessionId}\n${entry.runFence}`

async function opened(entry: StoredSharedToolCaller): Promise<KeptSharedToolCaller | null> {
  try {
    const payload = jsonObject(JSON.parse(await unsealRelaySecret(entry.sealed)))
    const token = payload?.token
    const caller: Record<string, string> = {}
    for (const [name, value] of Object.entries(jsonObject(payload?.caller) ?? {})) {
      if (typeof value !== 'string') {
        return null
      }
      caller[name] = value
    }
    if (typeof token !== 'string' || !jsonObject(payload?.caller)) {
      return null
    }
    return {
      sessionId: entry.sessionId,
      runFence: entry.runFence,
      owner: entry.owner,
      caller,
      token
    }
  } catch {
    return null
  }
}

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
  /** Bumped by each owner's revoke, so a seal racing it never writes that owner back. */
  private readonly revocations = new Map<string, number>()
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
    const opening = [...this.locked].slice(0, UNLOCK_BATCH)
    const kept: KeptSharedToolCaller[] = []
    for (const entry of opening) {
      if (await this.open(entry)) {
        kept.push(entry.kept!)
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
    await this.load()
    const files = this.files
    if (!files || (resealed === undefined && !relaySealingProtected())) {
      return false
    }
    const revocation = this.revocations.get(caller.owner) ?? 0
    let sealed: string
    try {
      sealed =
        resealed ??
        (await sealRelaySecret(JSON.stringify({ caller: caller.caller, token: caller.token })))
    } catch {
      return false
    }
    // Its owner was revoked while sealing: a deleted bot's caller never reaches the file.
    if ((this.revocations.get(caller.owner) ?? 0) !== revocation) {
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
    /** A reattached run's fence: a still-locked entry of the chat moves to it instead of going. */
    carryLockedTo?: number
  ): Promise<void> {
    await this.load()
    const runs = [...(this.chats.get(sessionId)?.values() ?? [])]
    const carried =
      carryLockedTo === undefined ? undefined : runs.find((entry) => entry.kept === null)
    const writes: Promise<unknown>[] = []
    if (carried && carryLockedTo !== undefined) {
      // The reattached agent holds that entry's token, so the run's caller is it, not `current`.
      const moved: Entry = { stored: { ...carried.stored, runFence: carryLockedTo }, kept: null }
      this.put(moved)
      writes.push(this.files?.put(moved.stored) ?? Promise.resolve())
    } else if (
      current &&
      this.chats.get(sessionId)?.get(current.runFence)?.kept?.token !== current.token
    ) {
      // A reattached caller is sealed already: its earlier entry's sealing is reused, not redone.
      const sealed = runs.find((entry) => entry.kept?.token === current.token)?.stored.sealed
      await this.keep(current, sealed)
    }
    const stays = carried ? carryLockedTo : current?.runFence
    for (const entry of runs) {
      if (entry.stored.runFence !== stays) {
        writes.push(this.retire(entry))
      }
    }
    await Promise.all(writes.map((write) => write.catch(() => {})))
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
    this.revocations.set(owner, (this.revocations.get(owner) ?? 0) + 1)
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

export function forgetKeptSharedToolCallers(owner: string): Promise<void> {
  return sharedToolCallerStore.forgetOwner(owner)
}
