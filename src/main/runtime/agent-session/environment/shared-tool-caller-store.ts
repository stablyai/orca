// Kept chats' shared-tool caller tokens, sealed at rest so a chat whose agent outlives the app keeps
// its caller identity. Only the session id, run fence and grant owner are in the clear; the caller
// payload carries the bot and MCP tokens, so it is sealed whole. One entry per kept chat run.
import { jsonObject } from '../../../../shared/json-stream/json-value-property'
import {
  relaySealingProtected,
  RelaySealedFile,
  relayUnlockThrottle,
  type RelayUnlockThrottle,
  sealRelaySecret,
  unsealRelaySecret
} from '../../../bots/tool-relay/relay-sealed-file'
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

function opened(entry: StoredSharedToolCaller): KeptSharedToolCaller | null {
  try {
    const payload = jsonObject(JSON.parse(unsealRelaySecret(entry.sealed)))
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

export class SharedToolCallerStore {
  private file: RelaySealedFile<StoredSharedToolCaller> | null = null
  /**
   * Each kept chat's run entries by fence, sealed as written, with what each opened to; null while
   * the keychain won't open it (it stays as written and is retried).
   */
  private readonly chats = new Map<string, Map<number, Entry>>()
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
    this.file ??= new RelaySealedFile(keptToolCallersPath(config.directory), isStoredCaller)
    this.loading ??= this.loadOnce(this.file)
    return this.loading
  }

  private async loadOnce(file: RelaySealedFile<StoredSharedToolCaller>): Promise<void> {
    // Loaded when used: the relay's revoke reaches this store.
    const { botToolRelay } = await import('../../../bots/tool-relay/bot-tool-relay')
    await botToolRelay.kept.loaded()
    let dropped = false
    for (const stored of await file.read()) {
      if (
        keptToolCallerRun(stored.sessionId) === stored.runFence &&
        botToolRelay.kept.keeps(stored.owner)
      ) {
        this.put({ stored, kept: opened(stored) })
      } else {
        dropped = true
      }
    }
    if (dropped) {
      await this.persist().catch(() => {})
    }
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
  unlock(): KeptSharedToolCaller[] {
    const locked = [...this.chats.values()].flatMap((runs) =>
      [...runs.values()].filter((entry) => entry.kept === null)
    )
    if (locked.length === 0 || !this.throttle.due()) {
      return []
    }
    return locked.flatMap((entry) => {
      entry.kept = opened(entry.stored)
      return entry.kept ? [entry.kept] : []
    })
  }

  /** The chat's kept caller from an earlier run of Orca, if its run is still the current one. */
  restored(sessionId: string): KeptSharedToolCaller | null {
    for (const { kept } of this.chats.get(sessionId)?.values() ?? []) {
      if (kept) {
        return kept
      }
    }
    return null
  }

  /** Durably keeps a caller; false (memory-only, so its launch is app-bound) when it can't. */
  async keep(caller: KeptSharedToolCaller): Promise<boolean> {
    await this.load()
    if (!this.file || !relaySealingProtected()) {
      return false
    }
    const stored: StoredSharedToolCaller = {
      sessionId: caller.sessionId,
      runFence: caller.runFence,
      owner: caller.owner,
      sealed: await sealRelaySecret(JSON.stringify({ caller: caller.caller, token: caller.token }))
    }
    const entry: Entry = { stored, kept: caller }
    this.put(entry)
    try {
      await this.persist()
      return true
    } catch {
      this.remove(entry)
      return false
    }
  }

  /**
   * `current` is the caller the chat's run now uses (null: none kept); every other entry of the
   * chat retires. A reattached run carries its restored caller over to its new fence.
   */
  async settle(sessionId: string, current: KeptSharedToolCaller | null): Promise<void> {
    await this.load()
    const runs = this.chats.get(sessionId)
    let changed = false
    for (const [fence, entry] of runs ?? []) {
      if (fence !== current?.runFence) {
        this.remove(entry)
        changed = true
      }
    }
    if (current && runs?.get(current.runFence)?.kept?.token !== current.token) {
      await this.keep(current)
      return
    }
    if (changed) {
      await this.persist().catch(() => {})
    }
  }

  /** Removes exactly this entry (its launch failed); other runs of the chat stay. */
  async drop(caller: KeptSharedToolCaller): Promise<void> {
    await this.load()
    const entry = this.chats.get(caller.sessionId)?.get(caller.runFence)
    if (entry?.kept === caller) {
      this.remove(entry)
      await this.persist()
    }
  }

  /** The owner's grant is being revoked: its callers go durably first. */
  async forgetOwner(owner: string): Promise<void> {
    await this.load()
    let changed = false
    for (const runs of [...this.chats.values()]) {
      for (const entry of [...runs.values()]) {
        if (entry.stored.owner === owner) {
          this.remove(entry)
          changed = true
        }
      }
    }
    if (changed) {
      await this.persist()
    }
  }

  private put(entry: Entry): void {
    const { sessionId, runFence } = entry.stored
    const runs = this.chats.get(sessionId) ?? new Map<number, Entry>()
    runs.set(runFence, entry)
    this.chats.set(sessionId, runs)
  }

  private remove(entry: Entry): void {
    const runs = this.chats.get(entry.stored.sessionId)
    if (runs?.get(entry.stored.runFence) === entry) {
      runs.delete(entry.stored.runFence)
      if (runs.size === 0) {
        this.chats.delete(entry.stored.sessionId)
      }
    }
  }

  private persist(): Promise<void> {
    return this.file
      ? this.file.write(() =>
          [...this.chats.values()].flatMap((runs) => [...runs.values()].map(({ stored }) => stored))
        )
      : Promise.resolve()
  }
}

export const sharedToolCallerStore = new SharedToolCallerStore()

export function forgetKeptSharedToolCallers(owner: string): Promise<void> {
  return sharedToolCallerStore.forgetOwner(owner)
}
