import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import { CODEX_LOGIN_CANCELLED_MESSAGE } from '../../shared/codex-auth-errors'
import {
  HOST_ACCOUNT_SIGN_IN_SETTLED_PHASES,
  isHostAccountSignInPage,
  type HostAccountSignInChannel,
  type HostAccountSignInProvider,
  type HostAccountSignInStatus
} from '../../shared/host-account-sign-in-types'

// Why under typical RPC timeouts: a long poll that outlives the client's own deadline reads as a failure.
const WAIT_MS = 20_000
// Why: a client that stopped polling (closed, slept, lost its link) must not hold the account queue.
const OWNER_SILENCE_MS = 90_000
// Why bounded: a cancel answers with what it knows; the client keeps waiting for the real outcome.
const CANCEL_WAIT_MS = 10_000
const MAX_ERROR_CHARS = 600
const NOT_ACTIVE = 'This sign-in is no longer active in this client.'
const SILENT_OWNER = 'The device that started this sign-in stopped answering.'
const SUPERSEDED = 'An account change on this host stopped the sign-in. Start it again.'
const LOGIN_CANCELLED_MESSAGES = new Set([
  'Claude sign-in was cancelled.',
  CODEX_LOGIN_CANCELLED_MESSAGE
])

export type HostAccountSignInRunner = (
  provider: HostAccountSignInProvider,
  channel: HostAccountSignInChannel
) => Promise<Pick<HostAccountSignInStatus, 'claude' | 'codex'>>

type Flow = {
  owner: string
  status: HostAccountSignInStatus
  ended: AbortController
  /** Why the flow was told to stop; the login's own outcome still decides how it settles. */
  stop: 'cancelled' | 'silent' | null
  done: Promise<void>
  code: PromiseWithResolvers<string>
  codeSent: boolean
  listeners: Set<() => void>
  silence: ReturnType<typeof setTimeout> | null
}

const settled = (flow: Flow): boolean => HOST_ACCOUNT_SIGN_IN_SETTLED_PHASES.has(flow.status.phase)

/**
 * Account sign-ins this host runs for a client on another device: one at a time per host, which
 * only the client that started it can read, answer or cancel. The login and its credentials stay
 * on this host; the client sees only the page to open and relays the code that page shows.
 * A flow settles only when its login does, so a cancel the login refused (it had already signed
 * in) still reports the account it added.
 */
export class HostAccountSignInFlows {
  private active: Flow | null = null
  /** Each owner's latest flow, so its final status stays readable after it ends. */
  private readonly latest = new Map<string, Flow>()

  constructor(
    private readonly run: HostAccountSignInRunner,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  start(owner: string, provider: HostAccountSignInProvider): HostAccountSignInStatus {
    if (this.platform === 'win32') {
      throw new Error(
        'Adding accounts from another device is not available on Windows hosts yet. Run `orca account add` in a terminal on that host.'
      )
    }
    const current = this.active
    if (current) {
      if (current.owner === owner && current.status.provider === provider && !current.stop) {
        this.touch(current)
        return current.status
      }
      throw new Error(
        current.owner === owner && current.stop
          ? 'The last sign-in is still stopping. Try again in a moment.'
          : 'Another account sign-in is already running on this host. Finish or cancel it first.'
      )
    }
    const code = Promise.withResolvers<string>()
    // Why: a flow that ends before a code arrives rejects this, and nobody may be listening.
    code.promise.catch(() => {})
    const flow: Flow = {
      owner,
      status: { flowId: randomUUID(), provider, revision: 1, phase: 'starting' },
      ended: new AbortController(),
      stop: null,
      done: Promise.resolve(),
      code,
      codeSent: false,
      listeners: new Set(),
      silence: null
    }
    this.active = flow
    this.latest.set(owner, flow)
    this.touch(flow)
    flow.done = this.runFlow(flow)
    return flow.status
  }

  private async runFlow(flow: Flow): Promise<void> {
    const channel: HostAccountSignInChannel = {
      signal: flow.ended.signal,
      onPrompt: (prompt) => {
        if (
          flow.status.phase === 'starting' &&
          !flow.stop &&
          isHostAccountSignInPage(flow.status.provider, prompt.url)
        ) {
          this.update(flow, { phase: 'waiting', prompt })
        }
      },
      nextCode: () => flow.code.promise
    }
    try {
      const result = await this.run(flow.status.provider, channel)
      this.update(flow, { phase: 'signedIn', prompt: undefined, ...result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.update(
        flow,
        flow.stop === 'cancelled'
          ? { phase: 'cancelled', prompt: undefined }
          : { phase: 'failed', prompt: undefined, error: failureMessage(flow, message) }
      )
    } finally {
      this.end(flow)
      if (this.active === flow) {
        this.active = null
      }
    }
  }

  /** The owner's flow once its revision passes `afterRevision`, it settles, or the wait times out. */
  async wait(
    owner: string,
    flowId: string,
    afterRevision: number,
    signal?: AbortSignal
  ): Promise<HostAccountSignInStatus> {
    const flow = this.own(owner, flowId)
    this.touch(flow)
    if (flow.status.revision > afterRevision || settled(flow)) {
      return flow.status
    }
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        flow.listeners.delete(done)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, WAIT_MS)
      flow.listeners.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
    return flow.status
  }

  submitCode(owner: string, flowId: string, code: string): HostAccountSignInStatus {
    const flow = this.own(owner, flowId)
    this.touch(flow)
    if (flow.status.phase !== 'waiting' || !flow.status.prompt?.needsCode || flow.stop) {
      throw new Error('This sign-in is not waiting for a code.')
    }
    if (flow.codeSent) {
      throw new Error('That code was already sent. Wait for the sign-in to finish.')
    }
    flow.codeSent = true
    this.update(flow, { phase: 'verifying' })
    flow.code.resolve(code)
    return flow.status
  }

  /** Stops the login, then answers with its outcome once it has one (or what it knows by then). */
  async cancel(owner: string, flowId: string): Promise<HostAccountSignInStatus> {
    const flow = this.own(owner, flowId)
    if (!settled(flow)) {
      flow.stop ??= 'cancelled'
      this.end(flow)
      const timeout = new AbortController()
      await Promise.race([flow.done, delay(CANCEL_WAIT_MS, undefined, { signal: timeout.signal })])
        .catch(() => {})
        .finally(() => timeout.abort())
    }
    return flow.status
  }

  private own(owner: string, flowId: string): Flow {
    const flow = this.latest.get(owner)
    if (!flow || flow.status.flowId !== flowId) {
      throw new Error(NOT_ACTIVE)
    }
    return flow
  }

  private touch(flow: Flow): void {
    if (settled(flow) || flow.stop) {
      return
    }
    if (flow.silence) {
      clearTimeout(flow.silence)
    }
    flow.silence = setTimeout(() => {
      if (!settled(flow) && !flow.stop) {
        flow.stop = 'silent'
        this.end(flow)
      }
    }, OWNER_SILENCE_MS)
  }

  private end(flow: Flow): void {
    if (flow.silence) {
      clearTimeout(flow.silence)
      flow.silence = null
    }
    flow.code.reject(new Error(NOT_ACTIVE))
    flow.ended.abort()
  }

  private update(flow: Flow, patch: Partial<HostAccountSignInStatus>): void {
    if (settled(flow)) {
      return
    }
    flow.status = { ...flow.status, ...patch, revision: flow.status.revision + 1 }
    for (const listener of flow.listeners) {
      listener()
    }
  }
}

function failureMessage(flow: Flow, raw: string): string {
  if (flow.stop === 'silent') {
    return SILENT_OWNER
  }
  const message = stripAnsiEscapeSequences(raw).trim()
  // Why: nobody here cancelled, so the login's "cancelled" means an account action on this host
  // superseded it, and the client would otherwise read it as its own cancel and say nothing.
  if (LOGIN_CANCELLED_MESSAGES.has(message)) {
    return SUPERSEDED
  }
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message
}
