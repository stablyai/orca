// One sign-in flow per host; only its initiating client receives the link or controls it.

import { resolveAntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { randomUUID } from 'node:crypto'
import type * as accountTypes from '../../shared/agent-accounts/antigravity/antigravity-account-types'
import {
  createAcpAgentConnection,
  type AcpAgentConnection
} from '../acp/process/acp-agent-connection'
import { ANTIGRAVITY_LAUNCH_SPEC } from './antigravity-acp-launch-spec'
import { acpPrivateTempConnect } from '../acp/launch/acp-private-temp'
import type { ConnectAcpAgent } from '../acp/process/acp-structured-connection'
import {
  resolveAcpLaunchInvocation,
  type AcpLaunchSettings
} from '../acp/launch/acp-structured-launch-resolution'
import { prepareAcpLaunch } from '../acp/launch/acp-structured-launch-preparation'
import { AcpConnectionClosedError } from '../acp/transport/acp-errors'
import { captureSignInModelPublisher } from './antigravity-sign-in-models'
import { antigravitySignInFailure } from './antigravity-sign-in-failure'
import type { structuredAgentHostLaunchSources } from '../runtime/agent-session/launch/structured-agent-launch-support'
import {
  AntigravitySignInCloseUnprovenError,
  AntigravitySignInSentence,
  antigravityChatSignIn,
  answerAntigravityChatAuth
} from './antigravity-chat-account'
import {
  antigravitySignInCallback,
  sendAntigravitySignInCallback,
  type AntigravitySignInPending
} from './antigravity-sign-in-callback'
import {
  antigravitySignInHome,
  antigravitySignInCredentialCommit
} from './antigravity-sign-in-home'
import { antigravitySignInServers } from './antigravity-sign-in-server'
import { antigravitySignInUrl } from './antigravity-sign-in-url'

// Match the server’s browser wait.
const FLOW_DEADLINE_MS = 300_000
const SECOND_LINK = {
  phase: 'failed',
  error: 'Antigravity started more than one Google sign-in request.'
} as const
const NOT_ACTIVE = 'This sign-in is no longer active in this client.'

type Phase = accountTypes.AntigravityChatSignInState['phase']
type Flow = {
  id: string
  owner: string
  intent: accountTypes.AntigravityChatSignInIntent
  ended: AbortController
  done: Promise<void>
  pending?: { url: string } & AntigravitySignInPending
  callbackSent?: boolean
  forwarding?: Promise<void>
  /** The replacement token is moving; only its own result may change the phase. */
  committing?: boolean
}

export type AntigravityChatSignInHost = {
  launchSources(signal: AbortSignal): Promise<
    Awaited<ReturnType<typeof structuredAgentHostLaunchSources>> & {
      commandSettings: AcpLaunchSettings
    }
  >
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
  next: Omit<accountTypes.AntigravityChatSignInState, 'flowId'>,
  cleanupFailed = false
): void {
  const { value } = antigravityChatSignIn.get()
  const shown = value.flow
  if (shown?.flowId !== current.id || (settled(shown.phase) && !cleanupFailed)) {
    return
  }
  if (current.committing) {
    return
  }
  const shownNext = { ...next, flowId: current.id, owner: current.owner, intent: current.intent }
  antigravityChatSignIn.set({ ...value, flow: shownNext })
  if (settled(next.phase)) {
    current.pending = undefined
    current.ended.abort()
  }
}

export function startAntigravityChatSignIn(
  host: AntigravityChatSignInHost,
  owner: string,
  intent: accountTypes.AntigravityChatSignInIntent = 'signIn'
): accountTypes.AntigravityChatSignInStartResult {
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
    return { flowId: active.id, status: readAntigravityChatSignInStatus(owner) }
  }
  const current: Flow = {
    id: randomUUID(),
    owner,
    intent,
    ended: new AbortController(),
    done: Promise.resolve()
  }
  active = current
  const { value } = antigravityChatSignIn.get()
  antigravityChatSignIn.set({
    ...value,
    flow: { flowId: current.id, owner, intent, phase: 'starting' }
  })
  current.done = runFlow(current, host)
  return { flowId: current.id, status: readAntigravityChatSignInStatus(owner) }
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
  const spec = ANTIGRAVITY_LAUNCH_SPEC
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
  const launch = await prepareAcpLaunch(resolve, closed)
  const home = launch.env.GEMINI_HOME
  const target = await antigravitySignInHome(launch, current.intent, spec.signIn, closed)
  const { replacement } = target
  let sessionId = ''
  try {
    const servers = antigravitySignInServers({
      connectServer: () => acpPrivateTempConnect(deps, closed),
      home: target.home,
      launch: target.launch,
      signal,
      closed,
      spawned: target.spawned
    })
    const method = resolveAntigravityChatAuthConfig(launch.antigravityChatAuth).method
    const watch = { ...target.watch, link: (link: string) => receiveLink(current, link) }
    await servers.run(watch, async (server) => {
      const initialized = await server.initialize()
      closed()
      if (
        initialized.authMethods &&
        !initialized.authMethods.some((entry) => entry.id === method)
      ) {
        throw new AntigravitySignInSentence(spec.authMethodUnavailableMessage)
      }
      await server.authenticate(method)
      current.pending = undefined
    })
    closed()
    publish(current, { phase: 'verifying' })
    const { started, live } = await servers.startOnSavedSignIn(
      { ...spec, signIn: target.watch },
      method,
      (id) => (sessionId = id)
    )
    if (replacement) {
      const commit = await antigravitySignInCredentialCommit(target.home, home, method)
      closed()
      current.committing = true
      try {
        await commit()
      } finally {
        current.committing = false
      }
      // Publish before yielding again so no late cancel or failure relabels the replaced login.
      answerAntigravityChatAuth(true)
    }
    publishModels(accountHome, started, live)
    if (replacement) {
      publish(current, { phase: 'signedIn' })
    }
  } finally {
    await target.remove(sessionId)
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
): Promise<accountTypes.AntigravityChatSignInState | null> {
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
): Promise<accountTypes.AntigravityChatSignInState | null> {
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
export function readAntigravityChatSignInStatus(
  owner: string
): accountTypes.AntigravityChatSignInStatus {
  const { value, revision } = antigravityChatSignIn.get()
  if (!value.flow) {
    return { revision, auth: value.auth, flow: null }
  }
  const { owner: starter, ...state } = value.flow
  const { phase, error } = state
  const flow = starter === owner ? state : { flowId: null, phase, ...(error ? { error } : {}) }
  return { revision, auth: value.auth, flow }
}
