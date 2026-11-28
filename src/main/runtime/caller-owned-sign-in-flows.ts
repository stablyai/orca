import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { HOST_ACCOUNT_SIGN_IN_FAILURE_COPY } from '../../shared/agent-accounts/host-account-sign-in-types'
import {
  settled,
  view,
  type CallerOwnedSignInChannel,
  type CallerOwnedSignInPolicy,
  type CallerOwnedSignInStatus,
  type SignInFlowStop,
  type SignInProgress
} from './caller-owned-sign-in-contract'

// Keep long polls inside typical RPC deadlines.
const WAIT_MS = 20_000
// Disconnected/nonpolling owners must not hold the host's account queue indefinitely.
const OWNER_SILENCE_MS = 90_000
// Bound cancel response time; final login outcome remains authoritative.
const CANCEL_WAIT_MS = 10_000
const NOT_ACTIVE = 'This sign-in is no longer active in this client.'

type Flow<TProvider extends string, TPrompt, TCode, TResult extends object> = {
  owner: string
  key: string | undefined
  status: SignInProgress<TProvider, TPrompt>
  result: Partial<TResult>
  ended: AbortController
  stop: SignInFlowStop | null
  done: Promise<void>
  code: PromiseWithResolvers<TCode>
  codeSent: boolean
  listeners: Set<() => void>
  silence: ReturnType<typeof setTimeout> | null
  /** When its owner last asked about it. */
  touchedAt: number
}

/** Serialize host-local sign-ins; only the initiating client may inspect/answer/cancel.
 * Credentials stay here. Settle with the login's outcome even if it refused cancellation. */
export class CallerOwnedSignInFlows<
  TProvider extends string,
  TPrompt,
  TCode,
  TResult extends object,
  /** What one start asks for beyond its provider, handed to that flow's run. */
  TInput = undefined
> {
  private active: Flow<TProvider, TPrompt, TCode, TResult> | null = null
  private readonly latest = new Map<string, Flow<TProvider, TPrompt, TCode, TResult>>()

  constructor(
    private readonly run: (
      provider: TProvider,
      channel: CallerOwnedSignInChannel<TPrompt, TCode>,
      input: TInput | undefined
    ) => Promise<TResult>,
    private readonly policy: CallerOwnedSignInPolicy<TProvider, TPrompt, TCode, TInput>
  ) {}

  start(
    owner: string,
    provider: TProvider,
    input?: TInput
  ): CallerOwnedSignInStatus<TProvider, TPrompt, TResult> {
    const refusal = this.policy.refuseStart?.(input)
    if (refusal) {
      throw new Error(refusal)
    }
    const key = this.policy.startKey?.(input)
    const current = this.active
    if (current) {
      if (
        current.owner === owner &&
        current.status.provider === provider &&
        current.key === key &&
        !current.stop
      ) {
        this.touch(current)
        return view(current)
      }
      const takeOverAfter = this.policy.ownerTakesOverAfterMs
      const abandonedByOwner =
        current.owner === owner &&
        takeOverAfter !== undefined &&
        Date.now() - current.touchedAt >= takeOverAfter
      if (
        !current.stop &&
        (abandonedByOwner || this.policy.supersedes?.(current.status, provider))
      ) {
        // Its owner's next wait reads it cancelled; its run stops on the abort.
        current.stop = 'cancelled'
        this.end(current)
        this.active = null
        return this.start(owner, provider, input)
      }
      throw new Error(
        current.owner === owner && current.stop
          ? 'The last sign-in is still stopping. Try again in a moment.'
          : this.policy.busyMessage
      )
    }
    const code = Promise.withResolvers<TCode>()
    // Startup failure may reject code before any listener attaches.
    code.promise.catch(() => {})
    const status: SignInProgress<TProvider, TPrompt> = {
      flowId: randomUUID(),
      provider,
      revision: 1,
      phase: 'starting'
    }
    const flow: Flow<TProvider, TPrompt, TCode, TResult> = {
      owner,
      key,
      status,
      result: {},
      ended: new AbortController(),
      stop: null,
      done: Promise.resolve(),
      code,
      codeSent: false,
      listeners: new Set(),
      silence: null,
      touchedAt: Date.now()
    }
    this.active = flow
    this.latest.set(owner, flow)
    this.touch(flow)
    flow.done = this.runFlow(flow, input)
    return view(flow)
  }

  /** The running flow's id, for host-side actions (sign-out) that must end it. */
  activeFlow(): { owner: string; flowId: string } | null {
    return this.active ? { owner: this.active.owner, flowId: this.active.status.flowId } : null
  }

  private async runFlow(
    flow: Flow<TProvider, TPrompt, TCode, TResult>,
    input: TInput | undefined
  ): Promise<void> {
    const channel: CallerOwnedSignInChannel<TPrompt, TCode> = {
      signal: flow.ended.signal,
      stopped: () => flow.stop,
      onPrompt: (prompt) => {
        if (
          flow.status.phase === 'starting' &&
          !flow.stop &&
          this.policy.acceptsPrompt(flow.status.provider, prompt)
        ) {
          this.update(flow, { phase: 'waiting', prompt })
        }
      },
      nextCode: () => flow.code.promise
    }
    const deadlineMs = this.policy.promptDeadlineMs
    const promptDeadline =
      deadlineMs === undefined
        ? null
        : setTimeout(() => {
            if (flow.status.phase === 'starting' && !flow.stop) {
              flow.stop = 'noPrompt'
              this.end(flow)
            }
          }, deadlineMs)
    try {
      const result = await this.run(flow.status.provider, channel, input)
      if (!settled(flow)) {
        flow.result = result
      }
      this.update(flow, { phase: 'signedIn', prompt: undefined })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.update(
        flow,
        flow.stop === 'cancelled'
          ? { phase: 'cancelled', prompt: undefined }
          : {
              phase: 'failed',
              prompt: undefined,
              ...(flow.stop === 'silent'
                ? { error: HOST_ACCOUNT_SIGN_IN_FAILURE_COPY.ownerSilent, errorCode: 'ownerSilent' }
                : flow.stop === 'noPrompt'
                  ? { error: HOST_ACCOUNT_SIGN_IN_FAILURE_COPY.noPrompt, errorCode: 'noPrompt' }
                  : this.policy.describeFailure(message))
            }
      )
    } finally {
      if (promptDeadline) {
        clearTimeout(promptDeadline)
      }
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
  ): Promise<CallerOwnedSignInStatus<TProvider, TPrompt, TResult>> {
    const flow = this.own(owner, flowId)
    this.touch(flow)
    if (flow.status.revision > afterRevision || settled(flow)) {
      return view(flow)
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
    return view(flow)
  }

  submitCode(
    owner: string,
    flowId: string,
    code: TCode
  ): CallerOwnedSignInStatus<TProvider, TPrompt, TResult> {
    const flow = this.own(owner, flowId)
    this.touch(flow)
    if (
      flow.status.phase !== 'waiting' ||
      !this.policy.acceptsCode(flow.status.prompt) ||
      flow.stop
    ) {
      throw new Error('This sign-in is not waiting for a code.')
    }
    if (flow.codeSent) {
      throw new Error('That code was already sent. Wait for the sign-in to finish.')
    }
    const accepted = this.policy.readCode ? this.policy.readCode(flow.status.prompt, code) : code
    flow.codeSent = true
    this.update(flow, { phase: 'verifying' })
    flow.code.resolve(accepted)
    return view(flow)
  }

  async cancel(
    owner: string,
    flowId: string
  ): Promise<CallerOwnedSignInStatus<TProvider, TPrompt, TResult>> {
    const flow = this.own(owner, flowId)
    if (!settled(flow)) {
      flow.stop ??= 'cancelled'
      this.end(flow)
      const timeout = new AbortController()
      await Promise.race([flow.done, delay(CANCEL_WAIT_MS, undefined, { signal: timeout.signal })])
        .catch(() => {})
        .finally(() => timeout.abort())
    }
    return view(flow)
  }

  private own(owner: string, flowId: string): Flow<TProvider, TPrompt, TCode, TResult> {
    const flow = this.latest.get(owner)
    if (!flow || flow.status.flowId !== flowId) {
      throw new Error(NOT_ACTIVE)
    }
    return flow
  }

  private touch(flow: Flow<TProvider, TPrompt, TCode, TResult>): void {
    if (settled(flow) || flow.stop) {
      return
    }
    flow.touchedAt = Date.now()
    if (flow.silence) {
      clearTimeout(flow.silence)
    }
    flow.silence = setTimeout(() => {
      if (!settled(flow) && !flow.stop) {
        flow.stop = 'silent'
        this.end(flow)
      }
    }, this.policy.ownerSilenceMs ?? OWNER_SILENCE_MS)
  }

  private end(flow: Flow<TProvider, TPrompt, TCode, TResult>): void {
    if (flow.silence) {
      clearTimeout(flow.silence)
      flow.silence = null
    }
    flow.code.reject(new Error(NOT_ACTIVE))
    flow.ended.abort()
  }

  private update(
    flow: Flow<TProvider, TPrompt, TCode, TResult>,
    patch: Partial<SignInProgress<TProvider, TPrompt>>
  ): void {
    if (settled(flow)) {
      return
    }
    flow.status = { ...flow.status, ...patch, revision: flow.status.revision + 1 }
    for (const listener of flow.listeners) {
      listener()
    }
  }
}
