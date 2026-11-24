// How many calls the relay lets in at once, counted from arrival (before any wait for a token), and
// the open calls a removed tool or deleted bot cuts. Streams, calls and session cleanup each have
// their own slots, so idle event streams can never starve tool calls or DELETE.

type Pool = 'stream' | 'call' | 'cleanup'

/** 16 MiB bodies × 64 calls is already ~1 GiB a bot; raise these only with that in mind. */
const LIMITS: Record<Pool, { perBot: number; perHost: number }> = {
  /** GET event streams stay open for a session's life. */
  stream: { perBot: 16, perHost: 256 },
  call: { perBot: 64, perHost: 512 },
  cleanup: { perBot: 8, perHost: 64 }
}

const poolOf = (method: string): Pool =>
  method === 'GET' ? 'stream' : method === 'DELETE' ? 'cleanup' : 'call'

/** One admitted call: aborting it cuts its wait, its upstream request and its stream. */
export type RelayCall = {
  botId: string
  credentialKey: string
  pool: Pool
  abort: AbortController
}

export class RelayAdmission {
  private readonly perBot = new Map<string, number>()
  private readonly perHost = new Map<Pool, number>()
  private readonly open = new Set<RelayCall>()

  /** The call's slot, or null when the bot or this computer has too many of its kind open. */
  admit(botId: string, method: string, credentialKey: string): RelayCall | null {
    const pool = poolOf(method)
    const botKey = `${pool}\0${botId}`
    const forBot = this.perBot.get(botKey) ?? 0
    const forHost = this.perHost.get(pool) ?? 0
    if (forBot >= LIMITS[pool].perBot || forHost >= LIMITS[pool].perHost) {
      return null
    }
    this.perBot.set(botKey, forBot + 1)
    this.perHost.set(pool, forHost + 1)
    const call = { botId, credentialKey, pool, abort: new AbortController() }
    this.open.add(call)
    return call
  }

  release(call: RelayCall): void {
    if (!this.open.delete(call)) {
      return
    }
    const botKey = `${call.pool}\0${call.botId}`
    const left = (this.perBot.get(botKey) ?? 1) - 1
    if (left > 0) {
      this.perBot.set(botKey, left)
    } else {
      this.perBot.delete(botKey)
    }
    this.perHost.set(call.pool, (this.perHost.get(call.pool) ?? 1) - 1)
  }

  /** Aborts every open call `matches` picks, with `reason`; their slots free as they unwind. */
  abortWhere(matches: (call: RelayCall) => boolean, reason: unknown): void {
    for (const call of this.open) {
      if (matches(call)) {
        call.abort.abort(reason)
      }
    }
  }
}
