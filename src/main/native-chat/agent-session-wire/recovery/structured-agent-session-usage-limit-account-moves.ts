import {
  sameAgentSessionAccountFolder,
  type AgentSessionAccountHome
} from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'

/** A chat continuing on another account than the one its cut hit: another folder, or another login
 *  in the same one (`login`), first seen at `at`. */
export type UsageLimitAccountMove = {
  cut: string
  to: AgentSessionAccountHome
  login: string | undefined
  at: number
}

/** Where each usage-limited chat moved since its cut. The login first seen in the cut's folder is
 *  kept in memory only, so a new login made while Orca was closed reads as the cut's own. */
export class UsageLimitAccountMoves {
  private readonly moves = new Map<string, UsageLimitAccountMove>()
  private readonly firstLogins = new Map<string, { cut: string; login: string }>()
  /** Shared by every chat of a pass: one login read per folder and source witness. */
  private reads = new Map<string, Promise<string | null>>()

  beginPass(): void {
    this.reads = new Map()
  }

  get(id: string): UsageLimitAccountMove | undefined {
    return this.moves.get(id)
  }

  /** The login now in the cut's folder when it is not the one first seen there for this cut. */
  async relogin(
    id: string,
    cut: string,
    key: string,
    read: () => Promise<string | null>
  ): Promise<string | undefined> {
    let pending = this.reads.get(key)
    if (!pending) {
      pending = read().catch(() => null)
      this.reads.set(key, pending)
    }
    const login = await pending
    const first = this.firstLogins.get(id)
    if (first?.cut !== cut) {
      if (login) {
        this.firstLogins.set(id, { cut, login })
      }
      return undefined
    }
    return login && login !== first.login ? login : undefined
  }

  /** Each destination counts from when it was chosen, so an older reading of it never releases. */
  note(
    id: string,
    cut: string,
    to: AgentSessionAccountHome | null,
    login: string | undefined,
    now: number
  ): void {
    const since = this.moves.get(id)
    if (!to) {
      this.moves.delete(id)
    } else if (
      since?.cut !== cut ||
      !sameAgentSessionAccountFolder(since.to, to) ||
      since.login !== login
    ) {
      this.moves.set(id, { cut, to, login, at: now })
    }
  }

  retain(shown: ReadonlySet<string>): void {
    for (const cache of [this.moves, this.firstLogins]) {
      for (const id of cache.keys()) {
        if (!shown.has(id)) {
          cache.delete(id)
        }
      }
    }
  }

  clear(): void {
    this.moves.clear()
    this.firstLogins.clear()
    this.beginPass()
  }
}
