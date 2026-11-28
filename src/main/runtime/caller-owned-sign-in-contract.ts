import {
  HOST_ACCOUNT_SIGN_IN_SETTLED_PHASES,
  type HostAccountSignInPhase
} from '../../shared/agent-accounts/host-account-sign-in-types'

export type SignInFlowStop = 'cancelled' | 'silent' | 'noPrompt'

export type SignInProgress<TProvider extends string, TPrompt> = {
  flowId: string
  provider: TProvider
  revision: number
  phase: HostAccountSignInPhase
  prompt?: TPrompt
  error?: string
  /** Set when `error` is Orca's own fixed copy, so clients can localize it. */
  errorCode?: string
}

/** One sign-in as the host reports it to the client that started it. */
export type CallerOwnedSignInStatus<
  TProvider extends string,
  TPrompt,
  TResult extends object
> = SignInProgress<TProvider, TPrompt> & Partial<TResult>

/** How a login running on the host reaches the person signing in elsewhere. */
export type CallerOwnedSignInChannel<TPrompt, TCode> = {
  signal: AbortSignal
  /** Why `signal` aborted: the person cancelled, the device that started it stopped answering, or no prompt came in time. */
  stopped: () => SignInFlowStop | null
  onPrompt: (prompt: TPrompt) => void
  /** What the person sent back; rejects if the flow ends first. */
  nextCode: () => Promise<TCode>
}

export type CallerOwnedSignInPolicy<
  TProvider extends string,
  TPrompt,
  TCode = unknown,
  TInput = undefined
> = {
  /** A reason this host cannot start this sign-in, or null. */
  refuseStart?: (input: TInput | undefined) => string | null
  /** Starts with different keys are different sign-ins, so a repeat start resumes only its own. */
  startKey?: (input: TInput | undefined) => string | undefined
  /** The host publishes this prompt to another device, so it is checked before it is shown. */
  acceptsPrompt: (provider: TProvider, prompt: TPrompt) => boolean
  acceptsCode: (prompt: TPrompt | undefined) => boolean
  /** Checks what was sent against the prompt it answers and returns what the run gets; throwing
   * refuses it without spending the flow's one answer. */
  readCode?: (prompt: TPrompt | undefined, code: TCode) => TCode
  /** Maps a raw login failure to what the client is told. */
  describeFailure: (message: string) => { error: string; errorCode?: string }
  busyMessage: string
  /** Whether a start of `next` replaces the running flow instead of being refused (newest wins). */
  supersedes?: (running: SignInProgress<TProvider, TPrompt>, next: TProvider) => boolean
  /** How long the owner may go without asking before the flow ends (default OWNER_SILENCE_MS). A sign-in
   *  finished on this host outlives a caller that slept meanwhile, up to its own deadline. */
  ownerSilenceMs?: number
  /** After this long without its owner asking, a new start from that same owner replaces the flow, so a
   *  client that lost it (an app killed on the sign-in page) isn't refused until owner silence ends it. */
  ownerTakesOverAfterMs?: number
  /** How long the login may run without publishing a prompt before the flow fails; unset waits for the login's own deadline. */
  promptDeadlineMs?: number
}

export function view<TProvider extends string, TPrompt, TResult extends object>(flow: {
  status: SignInProgress<TProvider, TPrompt>
  result: Partial<TResult>
}): CallerOwnedSignInStatus<TProvider, TPrompt, TResult> {
  return { ...flow.status, ...flow.result }
}

export function settled(flow: { status: { phase: HostAccountSignInPhase } }): boolean {
  return HOST_ACCOUNT_SIGN_IN_SETTLED_PHASES.has(flow.status.phase)
}
