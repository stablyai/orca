// Kept chats' shared-tool caller tokens, sealed at rest so a chat whose agent outlives the app keeps
// its caller identity. Only the session id, run fence and grant owner are in the clear; the caller
// payload carries the bot and MCP tokens, so it is sealed whole. One entry per kept chat run.
import {
  relaySealingProtected,
  RelaySealedFile,
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
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const entry = value as Record<string, unknown>
  return (
    typeof entry.sessionId === 'string' &&
    typeof entry.runFence === 'number' &&
    Number.isSafeInteger(entry.runFence) &&
    typeof entry.owner === 'string' &&
    typeof entry.sealed === 'string'
  )
}

function opened(entry: StoredSharedToolCaller): KeptSharedToolCaller | null {
  try {
    const payload: unknown = JSON.parse(unsealRelaySecret(entry.sealed))
    const { caller, token } = (payload ?? {}) as { caller?: unknown; token?: unknown }
    if (
      typeof token !== 'string' ||
      typeof caller !== 'object' ||
      caller === null ||
      !Object.values(caller).every((value) => typeof value === 'string')
    ) {
      return null
    }
    return {
      sessionId: entry.sessionId,
      runFence: entry.runFence,
      owner: entry.owner,
      caller: caller as Record<string, string>,
      token
    }
  } catch {
    return null
  }
}

const key = (sessionId: string, runFence: number) => `${sessionId}\0${runFence}`

export class SharedToolCallerStore {
  private file: RelaySealedFile<StoredSharedToolCaller> | null = null
  /** Each kept run's entry, sealed as written, with what it opened to. */
  private readonly entries = new Map<
    string,
    { stored: StoredSharedToolCaller; kept: KeptSharedToolCaller }
  >()
  private loading: Promise<KeptSharedToolCaller[]> | null = null

  /**
   * The kept callers whose chat's placement still names their run and whose owner's grant is kept;
   * every other entry (and one that won't open) is dropped from the file. Once per run, and only
   * once both the app data folder and the chat host's runs are known; until then nothing is kept.
   */
  async load(): Promise<KeptSharedToolCaller[]> {
    const config = keptToolGrantsConfig()
    if (!config || !keptToolCallerRunsInstalled()) {
      return []
    }
    this.file ??= new RelaySealedFile(keptToolCallersPath(config.directory), isStoredCaller)
    this.loading ??= this.loadOnce(this.file)
    return this.loading
  }

  private async loadOnce(
    file: RelaySealedFile<StoredSharedToolCaller>
  ): Promise<KeptSharedToolCaller[]> {
    // Loaded when used: the relay's revoke reaches this store.
    const { botToolRelay } = await import('../../../bots/tool-relay/bot-tool-relay')
    await botToolRelay.keptGrantsLoaded()
    let dropped = false
    for (const stored of await file.read()) {
      const kept =
        keptToolCallerRun(stored.sessionId) === stored.runFence && botToolRelay.keeps(stored.owner)
          ? opened(stored)
          : null
      if (kept) {
        this.entries.set(key(stored.sessionId, stored.runFence), { stored, kept })
      } else {
        dropped = true
      }
    }
    if (dropped) {
      await this.persist().catch(() => {})
    }
    return [...this.entries.values()].map(({ kept }) => kept)
  }

  /** The chat's kept caller from an earlier run of Orca, if its run is still the current one. */
  restored(sessionId: string): KeptSharedToolCaller | null {
    for (const { kept } of this.entries.values()) {
      if (kept.sessionId === sessionId) {
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
    const entryKey = key(caller.sessionId, caller.runFence)
    this.entries.set(entryKey, { stored, kept: caller })
    try {
      await this.persist()
      return true
    } catch {
      if (this.entries.get(entryKey)?.stored === stored) {
        this.entries.delete(entryKey)
      }
      return false
    }
  }

  /**
   * `current` is the caller the chat's run now uses (null: none kept); every other entry of the
   * chat retires. A reattached run carries its restored caller over to its new fence.
   */
  async settle(sessionId: string, current: KeptSharedToolCaller | null): Promise<void> {
    await this.load()
    const currentKey = current ? key(current.sessionId, current.runFence) : null
    let changed = false
    for (const [entryKey, { kept }] of this.entries) {
      if (kept.sessionId === sessionId && entryKey !== currentKey) {
        this.entries.delete(entryKey)
        changed = true
      }
    }
    if (current && currentKey !== null && this.entries.get(currentKey)?.kept.token !== current.token) {
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
    const entryKey = key(caller.sessionId, caller.runFence)
    if (this.entries.get(entryKey)?.kept === caller) {
      this.entries.delete(entryKey)
      await this.persist()
    }
  }

  /** The owner's grant is being revoked: its callers go durably first. */
  async forgetOwner(owner: string): Promise<void> {
    await this.load()
    let changed = false
    for (const [entryKey, { kept }] of this.entries) {
      if (kept.owner === owner) {
        this.entries.delete(entryKey)
        changed = true
      }
    }
    if (changed) {
      await this.persist()
    }
  }

  private persist(): Promise<void> {
    return this.file
      ? this.file.write([...this.entries.values()].map(({ stored }) => stored))
      : Promise.resolve()
  }
}

export const sharedToolCallerStore = new SharedToolCallerStore()

export function forgetKeptSharedToolCallers(owner: string): Promise<void> {
  return sharedToolCallerStore.forgetOwner(owner)
}
