// A chat whose tools run in a process other chats share gets a token in place of its identity. Tokens
// live only in memory: this run's, and, for a chat whose agent its daemon start keeps, that start's,
// which hands it back to a restarted app. Any other token from a closed chat or an earlier run names
// no one.
import { createHash, randomBytes } from 'node:crypto'
import { BOT_TOOLS_TOKEN_ENV } from '../../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import {
  sharedToolProcessSessionEnv,
  type PublishSharedToolProcessSessionEnv
} from './shared-tool-process-session-env'
import type { ToolRelayFrontCaller } from '../../../daemon/protocol/daemon-tool-relay-front-protocol'
import { stageProviderRelayFrontCaller } from '../../../provider-relay/provider-relay-front-pins'

const callers = new Map<string, Readonly<Record<string, string>>>()

/** Each kept chat's caller, the one its daemon start holds for its agent's tools. */
const keptCallers = new Map<string, ToolRelayFrontCaller>()

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

/** A kept agent's caller, as its daemon start handed it back to this run. */
export function restoreKeptSharedToolCaller(chatKey: string, kept: ToolRelayFrontCaller): void {
  const replaced = keptCallers.get(chatKey)
  if (replaced && replaced.token !== kept.token) {
    callers.delete(hashToken(replaced.token))
  }
  keptCallers.set(chatKey, kept)
  callers.set(hashToken(kept.token), kept.caller)
}

/**
 * The chat's kept caller names no one from now on: its agent's relay was closed, or the daemon
 * start no longer holds it. With `token`, only while the chat's kept caller is still that one.
 */
export function forgetKeptSharedToolChat(chatKey: string, token?: string): void {
  const kept = keptCallers.get(chatKey)
  if (kept && (token === undefined || kept.token === token)) {
    keptCallers.delete(chatKey)
    callers.delete(hashToken(kept.token))
  }
}

/** The owner's grant was revoked: its kept chats' callers name no one from now on. */
export function forgetKeptSharedToolCallers(owner: string): void {
  for (const [chatKey, kept] of keptCallers) {
    if (kept.owner === owner) {
      keptCallers.delete(chatKey)
      callers.delete(hashToken(kept.token))
    }
  }
}

/** The caller identity a token was issued for; null for a token this run never issued or ended. */
export function sharedToolProcessCaller(token: string): Readonly<Record<string, string>> | null {
  return callers.get(hashToken(token)) ?? null
}

/** One launched child's token, from spawn until its process exits (`end`). */
export class SharedToolProcessSession {
  private withdraw: Promise<(() => Promise<void>) | null> | null = null
  private ended = false
  /** The chat whose daemon start keeps this token with its agent. */
  private keptFor: string | null = null
  /** Handed to the spawn, but the chat's kept caller only once this launch's agent started. */
  private pendingKeep: { chatKey: string; kept: ToolRelayFrontCaller } | null = null

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
   * The chat's kept caller, for its agent its daemon start kept running: the same token its tools
   * already hold. Null when none is kept for the chat.
   */
  static reattached(
    spec: { sharedToolProcess?: { publishSessionEnv: PublishSharedToolProcessSessionEnv } },
    sealed: Readonly<Record<string, string>>,
    chatKey: string,
    agentVersion?: string
  ): SharedToolProcessSession | null {
    const kept = keptCallers.get(chatKey)
    if (!spec.sharedToolProcess || !kept) {
      return null
    }
    const { tools } = sharedToolProcessSessionEnv(sealed, kept.token)
    const key = hashToken(kept.token)
    callers.set(key, kept.caller)
    const session = new SharedToolProcessSession(
      kept.token,
      key,
      sealed,
      tools,
      spec.sharedToolProcess.publishSessionEnv,
      agentVersion
    )
    session.keptFor = chatKey
    return session
  }

  /**
   * Hands this token to the daemon start the chat's launch is pinned to, with the agent's spawn, so
   * a restarted app gets it back; false (it lives in this run only) when the launch has no front.
   */
  keepWith(chatKey: string, owner: string): boolean {
    const caller = callers.get(this.key)
    const kept = caller ? { owner, token: this.token, caller: { ...caller } } : null
    if (this.ended || !kept || !stageProviderRelayFrontCaller(chatKey, kept)) {
      return false
    }
    // A reattach keeps the chat's kept caller as it is: the agent already holds that token.
    this.pendingKeep = { chatKey, kept }
    return true
  }

  /** This launch's own agent started: its token is the chat's kept caller from now on. */
  started(): void {
    const pending = this.pendingKeep
    this.pendingKeep = null
    if (!pending || this.ended) {
      return
    }
    const earlier = keptCallers.get(pending.chatKey)
    if (earlier && earlier.token !== pending.kept.token) {
      callers.delete(hashToken(earlier.token))
    }
    keptCallers.set(pending.chatKey, pending.kept)
    this.keptFor = pending.chatKey
  }

  /** Another session took this launch's place (a reattach reuses its kept one): its token goes. */
  discard(): void {
    this.ended = true
    callers.delete(this.key)
    this.forgetKept()
  }

  /** `opened` once its session's tools have their identity. A chat that fails to publish keeps no
   *  identity and refuses; a bot's session doesn't start, since without its token it would pass as
   *  the owner, past the bot's own limits. */
  async publishFor<T extends { link?: { handle: { nativeId: string } } }>(opened: T): Promise<T> {
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

  end(): void {
    if (this.ended) {
      return
    }
    this.ended = true
    callers.delete(this.key)
    this.forgetKept()
    void this.withdrawPublished()
  }

  private forgetKept(): void {
    if (this.keptFor !== null && keptCallers.get(this.keptFor)?.token === this.token) {
      keptCallers.delete(this.keptFor)
    }
  }

  private async withdrawPublished(): Promise<void> {
    const withdraw = await this.withdraw
    await withdraw?.().catch((error: unknown) => {
      console.warn('[agent-session] Could not withdraw a shared tool process session', error)
    })
  }
}
