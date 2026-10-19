// Signs this host's Antigravity chats in with the server's own Google sign-in: a server spawned as a
// chat start spawns one prints the link, saves the sign-in to the chats' folder itself once the
// browser finishes, and then starts a session to prove it works. One flow per host, which only the
// client that started it follows, cancels or completes.

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AntigravityChatSignInState,
  AntigravityChatSignInStatus
} from '../../shared/antigravity-account-types'
import { createAcpAgentConnection, type AcpAgentConnection } from '../acp/acp-agent-connection'
import { ANTIGRAVITY_LAUNCH_SPEC, type AcpLaunchSpec } from '../acp/acp-launch-specs'
import { acpPrivateTempConnect } from '../acp/acp-private-temp'
import type { ConnectAcpAgent } from '../acp/acp-structured-connection'
import { resolveAcpLaunchInvocation } from '../acp/acp-structured-launch-resolution'
import { prepareAcpLaunch } from '../acp/acp-structured-launch-preparation'
import { AcpAgentError, AcpConnectionClosedError } from '../acp/acp-errors'
import { saveSignInModels } from './antigravity-sign-in-models'
import { isAgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { structuredAgentHostLaunchSources } from '../runtime/structured-agent-launch-support'
import {
  AntigravitySignInCloseUnprovenError,
  AntigravitySignInSentence,
  antigravityChatSignIn,
  closeAntigravitySignInOwner
} from './antigravity-chat-account'
import {
  antigravitySignInCallback,
  sendAntigravitySignInCallback,
  type AntigravitySignInPending
} from './antigravity-sign-in-callback'
import { removeAntigravitySignInSessionFiles } from './antigravity-sign-in-session-files'
import { antigravitySignInUrl } from './antigravity-sign-in-url'

// The server's own wait for the browser.
const FLOW_DEADLINE_MS = 300_000
const SIGN_IN_FAILED = 'Google sign-in for Antigravity failed. Start sign-in again.'
const SECOND_LINK = {
  phase: 'failed',
  error: 'Antigravity started more than one Google sign-in request.'
} as const
const NOT_ACTIVE = 'This sign-in is no longer active in this client.'
const SESSION_FAILED =
  'Antigravity authenticated, but could not initialize a session or load models.'

type Phase = AntigravityChatSignInState['phase']
type Flow = {
  id: string
  /** The caller that started it, the only one shown its link and allowed to act on it. */
  owner: string
  ended: AbortController
  done: Promise<void>
  pending?: { url: string } & AntigravitySignInPending
  callbackSent?: boolean
  /** The pasted address on its way to the server, which the flow's end aborts. */
  forwarding?: Promise<void>
}

export type AntigravityChatSignInHost = {
  launchSources(): ReturnType<typeof structuredAgentHostLaunchSources>
  /** Rejects when a chat is not proven stopped. */
  stopLiveChats(): Promise<void>
  connect?: ConnectAcpAgent<AcpAgentConnection>
}

// The operation from its accepted Start until its work has unwound, whatever its shown phase.
let active: Flow | null = null

const settled = (phase: Phase): boolean =>
  phase !== 'starting' && phase !== 'waiting' && phase !== 'verifying'
const running = (current: Flow | null): current is Flow => {
  const shown = antigravityChatSignIn.get().value.flow
  return current !== null && shown?.flowId === current.id && !settled(shown.phase)
}

function publish(
  current: Flow,
  next: Omit<AntigravityChatSignInState, 'flowId'>,
  cleanupFailed = false
): void {
  const { value } = antigravityChatSignIn.get()
  const shown = value.flow
  // An ended flow's late news is dropped, and a later flow owns the state.
  if (shown?.flowId !== current.id || (settled(shown.phase) && !cleanupFailed)) {
    return
  }
  const shownNext = { ...next, flowId: current.id, owner: current.owner }
  antigravityChatSignIn.set({ ...value, flow: shownNext })
  if (settled(next.phase)) {
    current.pending = undefined
    current.ended.abort()
  }
}

/** Starts a sign-in for `owner`, or answers its own running one; another client's is refused. */
export function startAntigravityChatSignIn(
  host: AntigravityChatSignInHost,
  owner: string
): { flowId: string } {
  // A host whose chats are refused (supportsAcpStructuredLocation) signs none in.
  if (ANTIGRAVITY_LAUNCH_SPEC.managedRuntime.pin() === null) {
    throw new Error(`Antigravity chats are not available on ${process.platform} ${process.arch}.`)
  }
  if (active) {
    if (active.owner !== owner) {
      throw new Error('Antigravity sign-in is already in progress in another client.')
    }
    if (!running(active)) {
      throw new Error('The last Antigravity sign-in is still stopping. Try again in a moment.')
    }
    return { flowId: active.id }
  }
  const current: Flow = {
    id: randomUUID(),
    owner,
    ended: new AbortController(),
    done: Promise.resolve()
  }
  active = current
  const { value } = antigravityChatSignIn.get()
  antigravityChatSignIn.set({ ...value, flow: { flowId: current.id, owner, phase: 'starting' } })
  current.done = runFlow(current, host)
  return { flowId: current.id }
}

async function runFlow(current: Flow, host: AntigravityChatSignInHost): Promise<void> {
  const deadline = setTimeout(() => publish(current, { phase: 'expired' }), FLOW_DEADLINE_MS)
  let signingIn = false
  try {
    await ANTIGRAVITY_LAUNCH_SPEC.launchGate.run(host.stopLiveChats, () => {
      signingIn = true
      return signIn(current, host)
    })
    publish(current, { phase: 'signedIn' })
  } catch (error) {
    const phase = antigravityChatSignIn.get().value.flow?.phase
    const expected =
      (phase === 'cancelled' || phase === 'expired') &&
      (error instanceof AcpConnectionClosedError || error === current.ended.signal.reason)
    if (!expected) {
      console.warn('[antigravity] chat sign-in failed:', error)
    }
    // Before the sign-in runs, a refusal is the gate's or the chat stop's own sentence.
    const message =
      signingIn || !(error instanceof Error) ? antigravitySignInFailure(error) : error.message
    publish(
      current,
      { phase: 'failed', error: message },
      error instanceof AntigravitySignInCloseUnprovenError
    )
  } finally {
    clearTimeout(deadline)
    current.ended.abort()
    await current.forwarding?.catch(() => {})
    if (active === current) {
      active = null
    }
  }
}

async function signIn(current: Flow, host: AntigravityChatSignInHost): Promise<void> {
  const spec: AcpLaunchSpec = ANTIGRAVITY_LAUNCH_SPEC
  const { signal } = current.ended
  const closed = (): void => signal.throwIfAborted()
  const { accountHome, env, commandSettings, dataDirectory } = await host.launchSources()
  const deps = { spec, dataDirectory, connect: host.connect ?? createAcpAgentConnection }
  const resolve = () =>
    resolveAcpLaunchInvocation(spec, accountHome, {
      resolveEnvironment: async () => env,
      resolveCommandSettings: () => commandSettings,
      dataDirectory
    })
  // Never downloads: an unresolved runtime refuses as a chat start does.
  const launch = await prepareAcpLaunch(deps, resolve, closed)
  const connect = await acpPrivateTempConnect(deps, closed)
  const home = launch.env.GEMINI_HOME
  const cwd = await mkdtemp(join(tmpdir(), 'orca-antigravity-sign-in-'))
  let connection: AcpAgentConnection | null = null
  // Removed once the server is proven gone and this start knows which session it made.
  const owned = { sessionId: '', exited: false, done: false, disposed: false }
  const disposeWhenGone = async (): Promise<void> => {
    if (!owned.exited || !owned.done || owned.disposed) {
      return
    }
    owned.disposed = true
    const files = removeAntigravitySignInSessionFiles(home, owned.sessionId, cwd)
    await Promise.all([files, rm(cwd, { recursive: true, force: true })]).catch((error: unknown) =>
      console.warn('[antigravity] sign-in session files not removed:', error)
    )
  }
  try {
    connection = connect(
      { ...launch, args: spec.args({ fullAccess: false, pluginDir: null }), cwd },
      {
        clientInfo: { name: 'orca', version: '1' },
        signIn: { ...ANTIGRAVITY_LAUNCH_SPEC.signIn, link: (link) => receiveLink(current, link) }
      }
    )
    const server = connection
    server.onExit(() => {
      owned.exited = true
      void disposeWhenGone()
    })
    const stop = (): void => void server.close().catch(() => false)
    signal.addEventListener('abort', stop, { once: true })
    try {
      // Resolves once the browser finishes, or at once when the folder is already signed in.
      await connection.authenticate('oauth-personal')
      publish(current, { phase: 'verifying' })
      // Signed in only once a session starts; its start also answers the host's status.
      const started = await connection.start({ cwd, mcpServers: [] }).catch((error: unknown) => {
        // Google accepted the sign-in, so a plain session refusal is the server's own.
        const plain = error instanceof AcpAgentError && error.code === -32603
        throw plain && antigravitySignInFailure(error) === SIGN_IN_FAILED
          ? new AntigravitySignInSentence(SESSION_FAILED)
          : error
      })
      owned.sessionId = started.sessionId
      current.pending = undefined
      saveSignInModels(spec, accountHome, started)
    } finally {
      signal.removeEventListener('abort', stop)
      await closeAntigravitySignInOwner(home, server)
    }
  } finally {
    owned.done = true
    owned.exited ||= !connection || connection.exited
    await disposeWhenGone()
  }
}

/** The printed line and the helper carry the same link; a different one, at any point while the
 *  flow runs, fails it. */
function receiveLink(current: Flow, link: string): void {
  const parsed = antigravitySignInUrl(link)
  if (current.ended.signal.aborted || !parsed || parsed.url === current.pending?.url) {
    return
  }
  if (current.pending) {
    publish(current, SECOND_LINK)
    return
  }
  current.pending = parsed
  publish(current, { phase: 'waiting', url: link })
}

/** The sentence a person reads for a failed sign-in; the raw error goes only to the log. */
function antigravitySignInFailure(error: unknown): string {
  const cause = isAgentSessionPreSpawnError(error) ? error.cause : error
  if (cause instanceof AntigravitySignInSentence) {
    return cause.message
  }
  if (isAgentSessionPreSpawnError(error) && error.reason === 'runtimeNotInstalled') {
    return 'Antigravity is not installed on this host. Install it, then start sign-in again.'
  }
  if (error instanceof AcpAgentError) {
    // The server may put its own words in the answer's data rather than its message.
    const text = `${error.message} ${JSON.stringify(error.data ?? '')}`
    if (text.includes('SUBSCRIPTION_REQUIRED')) {
      return 'Google requires an eligible Antigravity subscription for this account.'
    }
    if (/onboarding failed|ineligible/i.test(text)) {
      return "This Google account can't use Antigravity. Sign in with a different account."
    }
    if (/access_denied|denied access|cancelled/i.test(text)) {
      return 'Google sign-in for Antigravity was not approved. Start sign-in again.'
    }
  }
  return SIGN_IN_FAILED
}

/** The caller's own running flow, or a refusal. */
function ownFlow(owner: string, flowId: string): Flow {
  const current = active
  if (!running(current) || current.id !== flowId || current.owner !== owner) {
    throw new Error(NOT_ACTIVE)
  }
  return current
}

/** Resolves once the flow has unwound and let go of the chats' starts, so a send right after
 *  Cancel isn't refused as a sign-in change. */
export async function cancelAntigravityChatSignIn(
  owner: string,
  flowId: string
): Promise<AntigravityChatSignInState | null> {
  const current = ownFlow(owner, flowId)
  publish(current, { phase: 'cancelled' })
  await current.done
  return readAntigravityChatSignInStatus(owner).flow
}

const CALLBACK_NOT_SENT =
  "Couldn't pass the sign-in on to Antigravity on this host. Start sign-in again."

/** Sends the address the browser ended on to the server's own listener, for a browser on another
 *  computer than this host; at most once per flow. */
export async function completeAntigravityChatSignIn(
  owner: string,
  flowId: string,
  callbackUrl: string
): Promise<AntigravityChatSignInState | null> {
  const current = ownFlow(owner, flowId)
  if (current.callbackSent) {
    throw new Error('That address was already sent. Wait for Google to finish signing in.')
  }
  if (antigravityChatSignIn.get().value.flow?.phase !== 'waiting' || !current.pending) {
    throw new Error('Wait for the Google sign-in link before you paste an address.')
  }
  const callback = antigravitySignInCallback(current.pending, callbackUrl)
  current.callbackSent = true
  publish(current, { phase: 'verifying' })
  current.forwarding = sendAntigravitySignInCallback(callback, current.ended.signal)
  try {
    await current.forwarding
  } catch (error) {
    // Cancel, expiry or the flow's own end stopped it; that result stands.
    if (!current.ended.signal.aborted) {
      console.warn('[antigravity] pasted sign-in address not delivered:', error)
      publish(current, { phase: 'failed', error: CALLBACK_NOT_SENT })
      throw new Error(CALLBACK_NOT_SENT)
    }
  }
  return readAntigravityChatSignInStatus(owner).flow
}

/** Calls `onChange` after every change of the sign-in status until the returned unsubscribe. */
export const subscribeAntigravityChatSignIn = (onChange: () => void): (() => void) =>
  antigravityChatSignIn.subscribe(onChange)

/** The status as `owner` sees it: another client's flow without its id or link. */
export function readAntigravityChatSignInStatus(owner: string): AntigravityChatSignInStatus {
  const { value, revision } = antigravityChatSignIn.get()
  if (!value.flow) {
    return { revision, auth: value.auth, flow: null }
  }
  const { owner: starter, ...state } = value.flow
  const { phase, error } = state
  const flow = starter === owner ? state : { flowId: null, phase, ...(error ? { error } : {}) }
  return { revision, auth: value.auth, flow }
}
