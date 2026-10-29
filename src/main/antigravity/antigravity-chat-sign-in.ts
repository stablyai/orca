// One sign-in flow per host; only its initiating client receives the link or controls it.

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
import { captureSignInModelPublisher } from './antigravity-sign-in-models'
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

// Match the server’s browser wait.
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
  owner: string
  ended: AbortController
  done: Promise<void>
  pending?: { url: string } & AntigravitySignInPending
  callbackSent?: boolean
  forwarding?: Promise<void>
}

export type AntigravityChatSignInHost = {
  launchSources(signal: AbortSignal): ReturnType<typeof structuredAgentHostLaunchSources>
  /** Rejects when a chat is not proven stopped. */
  stopLiveChats(): Promise<void>
  connect?: ConnectAcpAgent<AcpAgentConnection>
}

// Retain the flow until cleanup finishes, even after publishing a terminal phase.
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

export function startAntigravityChatSignIn(
  host: AntigravityChatSignInHost,
  owner: string
): { flowId: string } {
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
    // Gate and chat-stop refusals already carry displayable messages.
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
  const publishModels = captureSignInModelPublisher(
    spec,
    () => active === current && running(current) && !signal.aborted
  )
  const { accountHome, env, commandSettings, dataDirectory } = await host.launchSources(signal)
  const deps = { spec, dataDirectory, connect: host.connect ?? createAcpAgentConnection }
  const resolve = () =>
    resolveAcpLaunchInvocation(spec, accountHome, {
      resolveEnvironment: async () => env,
      resolveCommandSettings: () => commandSettings,
      dataDirectory
    })
  // Reuse chat launch resolution without downloading a runtime.
  const launch = await prepareAcpLaunch(deps, resolve, closed)
  const connect = await acpPrivateTempConnect(deps, closed)
  const home = launch.env.GEMINI_HOME
  const cwd = await mkdtemp(join(tmpdir(), 'orca-antigravity-sign-in-'))
  let connection: AcpAgentConnection | null = null
  // Wait for proven exit and session ownership before deleting files.
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
      await connection.authenticate('oauth-personal')
      publish(current, { phase: 'verifying' })
      // Authentication alone does not prove a chat can start.
      const started = await connection.start({ cwd, mcpServers: [] }).catch((error: unknown) => {
        const plain = error instanceof AcpAgentError && error.code === -32603
        throw plain && antigravitySignInFailure(error) === SIGN_IN_FAILED
          ? new AntigravitySignInSentence(SESSION_FAILED)
          : error
      })
      owned.sessionId = started.sessionId
      current.pending = undefined
      publishModels(accountHome, started, !connection.exited)
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

/** The printed URL and browser helper may report the same request twice. */
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

function antigravitySignInFailure(error: unknown): string {
  const cause = isAgentSessionPreSpawnError(error) ? error.cause : error
  if (cause instanceof AntigravitySignInSentence) {
    return cause.message
  }
  if (isAgentSessionPreSpawnError(error) && error.reason === 'runtimeNotInstalled') {
    return 'Antigravity is not installed on this host. Install it, then start sign-in again.'
  }
  if (error instanceof AcpAgentError) {
    // Provider errors may put the reason in data instead of message.
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

function ownFlow(owner: string, flowId: string): Flow {
  const current = active
  if (!running(current) || current.id !== flowId || current.owner !== owner) {
    throw new Error(NOT_ACTIVE)
  }
  return current
}

/** Await cleanup so the next chat start can acquire the launch gate. */
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

/** Forward a remote browser’s callback to the host’s listener once per flow. */
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
    if (!current.ended.signal.aborted) {
      console.warn('[antigravity] pasted sign-in address not delivered:', error)
      publish(current, { phase: 'failed', error: CALLBACK_NOT_SENT })
      throw new Error(CALLBACK_NOT_SENT)
    }
  }
  return readAntigravityChatSignInStatus(owner).flow
}

export const subscribeAntigravityChatSignIn = (onChange: () => void): (() => void) =>
  antigravityChatSignIn.subscribe(onChange)

/** Hide the flow ID and sign-in link from other clients. */
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
