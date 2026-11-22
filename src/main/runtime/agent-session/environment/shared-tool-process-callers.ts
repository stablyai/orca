// A chat whose tools run in a process other chats share gets a token in place of its identity. Tokens
// live only in this run's memory, so a token from a closed chat or an earlier run of Orca names no one.
import { createHash, randomBytes } from 'node:crypto'
import {
  sharedToolProcessSessionEnv,
  type PublishSharedToolProcessSessionEnv
} from './shared-tool-process-session-env'

const callers = new Map<string, Readonly<Record<string, string>>>()

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

/** The caller identity a token was issued for; null for a token this run never issued or ended. */
export function sharedToolProcessCaller(token: string): Readonly<Record<string, string>> | null {
  return callers.get(hashToken(token)) ?? null
}

/** One launched child's token, from spawn until its process exits (`end`). */
export class SharedToolProcessSession {
  private withdraw: Promise<(() => Promise<void>) | null> | null = null
  private ended = false

  private constructor(
    private readonly key: string,
    private readonly sealed: Readonly<Record<string, string>>,
    private readonly tools: Readonly<Record<string, string | null>>,
    private readonly publishSessionEnv: PublishSharedToolProcessSessionEnv
  ) {}

  /** A token for a launch whose tools run in a shared process; null for any other launch. */
  static forLaunch(
    spec: { sharedToolProcess?: { publishSessionEnv: PublishSharedToolProcessSessionEnv } },
    sealed: Readonly<Record<string, string>>
  ): SharedToolProcessSession | null {
    if (!spec.sharedToolProcess) {
      return null
    }
    const token = randomBytes(32).toString('base64url')
    const { caller, tools } = sharedToolProcessSessionEnv(sealed, token)
    const key = hashToken(token)
    callers.set(key, caller)
    return new SharedToolProcessSession(
      key,
      sealed,
      tools,
      spec.sharedToolProcess.publishSessionEnv
    )
  }

  /** `opened` once its session's tools have their identity; a failure leaves them with none. */
  async publishFor<T extends { link?: { handle: { nativeId: string } } }>(opened: T): Promise<T> {
    await this.publish(opened.link?.handle.nativeId)
    return opened
  }

  private async publish(providerSessionId: string | undefined): Promise<void> {
    if (this.ended || this.withdraw || providerSessionId === undefined) {
      return
    }
    const publish = this.publishSessionEnv
    this.withdraw = publish({
      env: this.sealed,
      providerSessionId,
      values: this.tools,
      live: () => !this.ended
    }).catch((error: unknown) => {
      console.warn('[agent-session] Could not give a shared tool process its session', error)
      return null
    })
    await this.withdraw
  }

  end(): void {
    if (this.ended) {
      return
    }
    this.ended = true
    callers.delete(this.key)
    void this.withdrawPublished()
  }

  private async withdrawPublished(): Promise<void> {
    const withdraw = await this.withdraw
    await withdraw?.().catch((error: unknown) => {
      console.warn('[agent-session] Could not withdraw a shared tool process session', error)
    })
  }
}
