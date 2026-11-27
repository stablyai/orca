// A chat whose tools run in a process other chats share gets a token in place of its identity. A token
// lives in this run's memory, and a kept chat's is also sealed at rest (shared-tool-caller-store), so
// an agent that outlives the app keeps its caller identity; any other token names no one after it.
import { createHash, randomBytes } from 'node:crypto'
import { BOT_TOOLS_TOKEN_ENV } from '../../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import {
  sharedToolProcessSessionEnv,
  type PublishSharedToolProcessSessionEnv
} from './shared-tool-process-session-env'
import { sharedToolCallerStore, type KeptSharedToolCaller } from './shared-tool-caller-store'

const callers = new Map<string, Readonly<Record<string, string>>>()

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

// A kept caller retired (its chat ended or was deleted, its bot revoked) names no one from now on.
sharedToolCallerStore.onRetired = (token) => callers.delete(hashToken(token))

/** Kept chats' callers from an earlier run of Orca, whose runs are still current. */
export function restoreKeptSharedToolCallers(kept: readonly KeptSharedToolCaller[]): void {
  for (const caller of kept) {
    callers.set(hashToken(caller.token), caller.caller)
  }
}

/** The caller identity a token was issued for; null for a token this run never issued or ended. */
export async function sharedToolProcessCaller(
  token: string
): Promise<Readonly<Record<string, string>> | null> {
  const key = hashToken(token)
  const known = callers.get(key)
  if (known) {
    return known
  }
  // A kept caller the keychain refused at startup may open now (at most once per 10 s).
  restoreKeptSharedToolCallers(await sharedToolCallerStore.unlock())
  return callers.get(key) ?? null
}

/** One launched child's token, from spawn until its process exits (`end`). */
export class SharedToolProcessSession {
  private withdraw: Promise<(() => Promise<void>) | null> | null = null
  private ended = false
  /** The kept entry this session's run uses, once `keepAs` wrote it. */
  private kept: KeptSharedToolCaller | null = null
  /** At its end, whether its agent runs on (handed to its daemon at quit), so the entry stays. */
  private outlivesApp: () => boolean = () => false
  /** The chat this session's run settled, so its end retires what it carried too. */
  private settledFor: string | null = null
  /** Retires the chat's earlier kept entries, once this run is placed. */
  private retireEarlier: (() => void) | null = null

  private constructor(
    private readonly token: string,
    private readonly key: string,
    private readonly sealed: Readonly<Record<string, string>>,
    private readonly tools: Readonly<Record<string, string | null>>,
    private readonly publishSessionEnv: PublishSharedToolProcessSessionEnv,
    private readonly agentVersion: string | undefined
  ) {}

  /** A token for a launch whose tools run in a shared process; null for any other launch. */
  static forLaunch(
    spec: { sharedToolProcess?: { publishSessionEnv: PublishSharedToolProcessSessionEnv } },
    sealed: Readonly<Record<string, string>>,
    agentVersion?: string
  ): SharedToolProcessSession | null {
    if (!spec.sharedToolProcess) {
      return null
    }
    const token = randomBytes(32).toString('base64url')
    const { caller, tools } = sharedToolProcessSessionEnv(sealed, token)
    const key = hashToken(token)
    callers.set(key, caller)
    return new SharedToolProcessSession(
      token,
      key,
      sealed,
      tools,
      spec.sharedToolProcess.publishSessionEnv,
      agentVersion
    )
  }

  /**
   * The chat's caller from an earlier run of Orca, for its agent kept running since: the same token
   * its tools already hold. Null when none was kept for the chat's current run.
   */
  static async reattached(
    spec: { sharedToolProcess?: { publishSessionEnv: PublishSharedToolProcessSessionEnv } },
    sealed: Readonly<Record<string, string>>,
    sessionId: string,
    runFence: number,
    outlivesApp: () => boolean,
    agentVersion?: string
  ): Promise<SharedToolProcessSession | null> {
    const restored = spec.sharedToolProcess ? await sharedToolCallerStore.restored(sessionId) : null
    if (!spec.sharedToolProcess || !restored) {
      return null
    }
    const { tools } = sharedToolProcessSessionEnv(sealed, restored.token)
    const key = hashToken(restored.token)
    callers.set(key, restored.caller)
    const session = new SharedToolProcessSession(
      restored.token,
      key,
      sealed,
      tools,
      spec.sharedToolProcess.publishSessionEnv,
      agentVersion
    )
    session.kept = { ...restored, runFence }
    session.outlivesApp = outlivesApp
    return session
  }

  /** Seals this token at rest for a run the agent may outlive; false keeps it memory-only. */
  async keepAs(
    run: { sessionId: string; runFence: number; owner: string },
    outlivesApp: () => boolean
  ): Promise<boolean> {
    const caller = callers.get(this.key)
    if (!caller || this.ended) {
      return false
    }
    const kept: KeptSharedToolCaller = { ...run, caller, token: this.token }
    if (!(await sharedToolCallerStore.keep(kept).catch(() => false))) {
      return false
    }
    this.kept = kept
    this.outlivesApp = outlivesApp
    return true
  }

  /**
   * This session is the chat's run's caller now, durably (with `carryLockedTo`, an entry the
   * keychain hasn't opened yet moves to that run instead). The chat's other entries retire once its
   * run is placed, when its tools get their identity (`publishFor`).
   */
  async settle(sessionId: string, carryLockedTo?: number): Promise<void> {
    const stays = await sharedToolCallerStore
      .adopt(sessionId, this.kept, carryLockedTo)
      .catch(() => this.kept?.runFence)
    this.settledFor = sessionId
    this.retireEarlier = () => {
      void sharedToolCallerStore.retireExcept(sessionId, stays).catch(() => {})
    }
  }

  /** `opened` once its session's tools have their identity. A chat that fails to publish keeps no
   *  identity and refuses; a bot's session doesn't start, since without its token it would pass as
   *  the owner, past the bot's own limits. */
  async publishFor<T extends { link?: { handle: { nativeId: string } } }>(opened: T): Promise<T> {
    this.retireEarlier?.()
    this.retireEarlier = null
    await this.publish(opened.link?.handle.nativeId)
    return opened
  }

  private async publish(providerSessionId: string | undefined): Promise<void> {
    if (this.ended || this.withdraw || providerSessionId === undefined) {
      return
    }
    const publish = this.publishSessionEnv
    const mustReach = this.sealed[BOT_TOOLS_TOKEN_ENV] !== undefined
    const published = publish({
      env: this.sealed,
      providerSessionId,
      values: this.tools,
      live: () => !this.ended,
      mustReach,
      ...(this.agentVersion ? { agentVersion: this.agentVersion } : {})
    })
    this.withdraw = published.catch((error: unknown) => {
      console.warn('[agent-session] Could not give a shared tool process its session', error)
      return null
    })
    await (mustReach ? published : this.withdraw)
  }

  /** Another session took this launch's place (a reattach reuses its kept one): its token goes. */
  discard(): void {
    this.ended = true
    callers.delete(this.key)
  }

  /** Its launch failed before any agent took the token: it goes, and so does its own kept entry. */
  abandon(): void {
    this.discard()
    if (this.kept) {
      void sharedToolCallerStore.drop(this.kept).catch(() => {})
    }
  }

  end(): void {
    if (this.ended) {
      return
    }
    this.ended = true
    callers.delete(this.key)
    // An agent handed to its daemon at quit keeps running with this token; anything else retires it.
    const chat = this.kept?.sessionId ?? this.settledFor
    if (chat !== null && !this.outlivesApp()) {
      void sharedToolCallerStore.settle(chat, null).catch(() => {})
    }
    void this.withdrawPublished()
  }

  private async withdrawPublished(): Promise<void> {
    const withdraw = await this.withdraw
    await withdraw?.().catch((error: unknown) => {
      console.warn('[agent-session] Could not withdraw a shared tool process session', error)
    })
  }
}
