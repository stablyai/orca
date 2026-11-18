// Drives a sign-in the host runs (`orca auth login`, `orca google connect`): waits for its prompt, shows
// it, waits for the end, and on Ctrl+C stops it on the host and says whether it had already finished.
import type { HostAccountSignInPhase } from '../../shared/agent-accounts/host-account-sign-in-types'
import type { RuntimeStatus } from '../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/connection/types'
import type { AuthInterruptSource } from './auth-interrupts'

const SETTLED = new Set<HostAccountSignInPhase>(['signedIn', 'failed', 'cancelled'])
// The host waits up to 10 s for the sign-in to stop; allow for the round trip.
const CANCEL_TIMEOUT_MS = 15_000

export type HostSignInFlow = {
  flowId: string
  revision: number
  phase: HostAccountSignInPhase
  error?: string
}

/** Refuses a host whose Orca predates the sign-in this command drives. */
export async function assertHostCapability(
  { client }: HandlerContext,
  capability: string,
  message: string
): Promise<void> {
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(capability)) {
    throw new RuntimeClientError('incompatible_runtime', message)
  }
}

class Interrupted extends Error {}

type DriveHostSignIn<T extends HostSignInFlow> = {
  flow: T
  methods: { wait: string; cancel: string }
  interrupts: AuthInterruptSource
  /** False: a prompt this command can't show; the flow is returned as it is, not cancelled. */
  accepts?: (waiting: T) => boolean
  /** Shows the prompt; may return what stops anything it started (a paste reader). */
  onWaiting: (waiting: T) => Promise<(() => void) | void>
  /** What Ctrl+C says when the host had already finished, or didn't confirm it stopped. */
  interrupted: { finished: string; unconfirmed: string }
}

export function driveHostSignIn<T extends HostSignInFlow>(
  ctx: HandlerContext,
  args: DriveHostSignIn<T>
): Promise<T> {
  return driveHostSignInAs<T, T>(ctx, { ...args, read: (answer) => answer })
}

/** The same, for a sign-in whose methods answer in their own shape: `read` makes each a flow. */
export async function driveHostSignInAs<T extends HostSignInFlow, A>(
  ctx: HandlerContext,
  args: DriveHostSignIn<T> & { read: (answer: A) => T }
): Promise<T> {
  const { flow, methods, read } = args
  const waitFor = async (from: T, done: (status: T) => boolean): Promise<T> => {
    let status = from
    while (!done(status)) {
      status = read(
        (
          await ctx.client.call<A>(
            methods.wait,
            { flowId: flow.flowId, afterRevision: status.revision },
            { timeoutMs: 60_000 }
          )
        ).result
      )
    }
    return status
  }
  let finished = false
  const interrupt = new AbortController()
  const interrupted = new Promise<never>((_, reject) => {
    interrupt.signal.addEventListener('abort', () => reject(new Interrupted()))
  })
  interrupted.catch(() => undefined)
  const stopListening = args.interrupts(() => interrupt.abort())
  // Every wait races the interrupt, so a signal never leaves the command blocked on the host.
  const step = <R>(work: Promise<R>): Promise<R> => Promise.race([work, interrupted])
  let stop = (): void => {}
  try {
    const waiting = await step(
      waitFor(flow, (status) => status.phase !== 'starting' || SETTLED.has(status.phase))
    )
    if (waiting.phase !== 'waiting' || args.accepts?.(waiting) === false) {
      finished = true
      return waiting
    }
    stop = (await step(args.onWaiting(waiting))) ?? stop
    const done = await step(waitFor(waiting, (status) => SETTLED.has(status.phase)))
    finished = true
    return done
  } catch (error) {
    if (!(error instanceof Interrupted)) {
      throw error
    }
    finished = true
    stopListening()
    throw await cancelAfterInterrupt(ctx, methods.cancel, flow.flowId, args.interrupted, read)
  } finally {
    stop()
    stopListening()
    if (!finished) {
      // A sign-in left waiting would hold this host's one pending slot until it times out.
      await ctx.client.call(methods.cancel, { flowId: flow.flowId }).catch(() => undefined)
    }
  }
}

/** Stops the host's sign-in and says plainly whether it had already finished. */
async function cancelAfterInterrupt<A>(
  ctx: HandlerContext,
  method: string,
  flowId: string,
  copy: { finished: string; unconfirmed: string },
  read: (answer: A) => HostSignInFlow
): Promise<RuntimeClientError> {
  process.stderr.write('\nStopping the sign-in on the host…\n')
  const outcome = await ctx.client
    .call<A>(method, { flowId }, { timeoutMs: CANCEL_TIMEOUT_MS })
    .then((response) => read(response.result).phase)
    .catch(() => null)
  if (outcome === 'signedIn') {
    return new RuntimeClientError('sign_in_interrupted', copy.finished)
  }
  if (outcome === 'cancelled' || outcome === 'failed') {
    return new RuntimeClientError('sign_in_interrupted', 'Sign-in cancelled.')
  }
  return new RuntimeClientError('sign_in_interrupted', copy.unconfirmed)
}
