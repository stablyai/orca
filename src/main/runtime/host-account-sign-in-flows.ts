import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import { CODEX_LOGIN_CANCELLED_MESSAGE } from '../../shared/codex-auth-errors'
import {
  HOST_ACCOUNT_SIGN_IN_FAILURE_COPY,
  HOST_ACCOUNT_SIGN_IN_SETTLED_PHASES,
  type HostAccountSignInFailureCode,
  isHostAccountSignInPage,
  type HostAccountSignInChannel,
  type HostAccountSignInProvider,
  type HostAccountSignInStatus
} from '../../shared/host-account-sign-in-types'

// Keep long polls inside typical RPC deadlines.
const WAIT_MS = 20_000
// Disconnected/nonpolling owners must not hold the host's account queue indefinitely.
const OWNER_SILENCE_MS = 90_000
// Bound cancel response time; final login outcome remains authoritative.
const CANCEL_WAIT_MS = 10_000
const MAX_ERROR_CHARS = 600
const NOT_ACTIVE = 'This sign-in is no longer active in this client.'
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
  stop: 'cancelled' | 'silent' | null
  done: Promise<void>
  code: PromiseWithResolvers<string>
  codeSent: boolean
  listeners: Set<() => void>
  silence: ReturnType<typeof setTimeout> | null
}

const settled = (flow: Flow): boolean => HOST_ACCOUNT_SIGN_IN_SETTLED_PHASES.has(flow.status.phase)

/** Serialize host-local sign-ins; only the initiating client may inspect/answer/cancel.
 * Credentials stay here. Settle with the login's outcome even if it refused cancellation. */
export class HostAccountSignInFlows {
  private active: Flow | null = null
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
    // Startup failure may reject code before any listener attaches.
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
          : { phase: 'failed', prompt: undefined, ...failure(flow, message) }
      )
    } finally {
      this.end(flow)
      if (this.active === flow) {
        this.active = null
      }
    }
  }

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

function coded(
  errorCode: HostAccountSignInFailureCode
): Pick<HostAccountSignInStatus, 'error' | 'errorCode'> {
  return { error: HOST_ACCOUNT_SIGN_IN_FAILURE_COPY[errorCode], errorCode }
}

function failure(flow: Flow, raw: string): Pick<HostAccountSignInStatus, 'error' | 'errorCode'> {
  if (flow.stop === 'silent') {
    return coded('ownerSilent')
  }
  const message = stripAnsiEscapeSequences(raw).trim()
  // Without our cancel, login cancellation means another host account action superseded this flow.
  if (LOGIN_CANCELLED_MESSAGES.has(message)) {
    return coded('superseded')
  }
  return {
    error: message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message
  }
}
