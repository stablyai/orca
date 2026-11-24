// Connect for a tool Orca signs in to: Orca's own page on 127.0.0.1 waits for the browser, one
// attempt per bot and tool at a time, and says "Signed in" only once the tokens are stored.
import { resolve } from 'node:path'
import type {
  BotToolSignInFailure,
  BotToolSignInProblem,
  BotToolSignInProgress
} from '../../../shared/bot-tool-sign-in'
import { commitBotToolOAuth, readBotToolOAuth } from '../bot-tool-credentials'
import { onBotToolCredentialEnded } from '../bot-tool-credential-ended'
import { serveLoopbackCallback } from '../../orca-profiles/cloud-auth/loopback-callback'
import {
  orcaCallbackOutcome,
  orcaCallbackReceivedPage
} from '../../orca-profiles/cloud-auth/profile-cloud-callback-page'
import {
  ATTEMPT_TTL_MS,
  BotToolSignInError,
  inTransaction,
  keyOf,
  type BotToolOAuthKey
} from './bot-tool-oauth'
import { beginBotToolSignIn, type BotToolSignInAttempt } from './bot-tool-oauth-sign-in'

export const BOT_TOOL_CALLBACK_PATH = '/callback'

export type BotToolSignInFlow = {
  controller: AbortController
  progress: BotToolSignInProgress
  /** The code exchange is running: the commit it makes ends the old sign-in, not this attempt. */
  completing: boolean
}

// The latest Connect per bot and tool, kept after it ends so a row can show how it went.
const flows = new Map<string, BotToolSignInFlow>()
const flowKey = (key: BotToolOAuthKey): string => keyOf({ ...key, folder: resolve(key.folder) })

let openBrowser: ((url: string) => Promise<void>) | null = null

/** Installed by the desktop app; a host without it (a server) signs in nowhere. */
export function setBotToolSignInBrowser(open: ((url: string) => Promise<void>) | null): void {
  openBrowser = open
}

// A removed tool, a deleted bot or a sign-out ends its Connect; a finished one is forgotten.
onBotToolCredentialEnded((ended) => {
  const id = flowKey(ended)
  const flow = flows.get(id)
  if (flow && !flow.completing) {
    flow.controller.abort(new BotToolSignInError('no-tool'))
    flows.delete(id)
  }
})

/** The tool's one open sign-in, from this computer or any device: the newest start ends the last. */
export function claimBotToolSignIn(key: BotToolOAuthKey): BotToolSignInFlow {
  const id = flowKey(key)
  flows.get(id)?.controller.abort(new BotToolSignInError('superseded'))
  const flow: BotToolSignInFlow = {
    controller: new AbortController(),
    progress: { state: 'idle' },
    completing: false
  }
  flows.set(id, flow)
  return flow
}

const FLOW_ERRORS = {
  timeout: 'expired',
  cancelled: 'cancelled',
  unavailable: 'unavailable',
  failed: 'refused'
} satisfies Record<string, BotToolSignInFailure>

export const failureOf = (error: unknown): BotToolSignInFailure => {
  if (error instanceof BotToolSignInError) {
    return error.code
  }
  const message = error instanceof Error ? error.message : ''
  return Object.values(FLOW_ERRORS).find((code) => code === message) ?? 'unavailable'
}

const FAILED_LINES: Partial<Record<BotToolSignInFailure, string>> = {
  denied: 'Access wasn’t allowed. You can close this tab.',
  expired: 'This sign-in expired. Start again in Orca.'
}

/**
 * Spends `attempt` on a returned query, marking `flow` as exchanging meanwhile (its commit ends the
 * old sign-in, not this attempt). Resolves with why it failed, or null once the tokens are stored.
 */
export async function completeFlowSignIn(
  flow: BotToolSignInFlow,
  attempt: BotToolSignInAttempt,
  query: URLSearchParams
): Promise<BotToolSignInFailure | null> {
  flow.completing = true
  try {
    await attempt.completeFromCallback(query)
    flow.progress = { state: 'done' }
    return null
  } catch (error) {
    const { signal } = flow.controller
    const code = signal.aborted ? endedBy(signal) : failureOf(error)
    flow.progress = { state: 'failed', code }
    return code
  } finally {
    flow.completing = false
  }
}

/** The page's second part, after the exchange: "Signed in" only once the tokens are stored. */
function outcomePage(failure: BotToolSignInFailure | null): string {
  return failure
    ? orcaCallbackOutcome({
        ok: false,
        heading: 'Couldn’t sign in',
        line: FAILED_LINES[failure] ?? 'Return to Orca and try again.'
      })
    : orcaCallbackOutcome({
        ok: true,
        heading: 'Signed in',
        line: 'You can close this tab and return to Orca.'
      })
}

/**
 * Keeps why the tool's sign-in couldn't start, or clears it, while `flow` is still the tool's latest
 * Connect and the sign-in is still the one it began on: a cancelled, replaced or signed-out attempt
 * leaves the status alone. Only the status field changes, so a refresh under way keeps its tokens.
 */
function keepProblem(
  key: BotToolOAuthKey,
  flow: BotToolSignInFlow,
  started: { url: string; grant: number },
  problem: BotToolSignInProblem | undefined
): Promise<void> {
  return inTransaction(key, () => {
    if (!flow.controller.signal.aborted && flows.get(flowKey(key)) === flow) {
      commitBotToolOAuth(
        key.folder,
        key.credentialId,
        (current) => {
          if (
            !current ||
            current.url !== started.url ||
            current.grant !== started.grant ||
            current.record.problem === problem
          ) {
            return undefined
          }
          const { problem: _old, ...record } = current.record
          return { ...current, record: problem ? { ...record, problem } : record }
        },
        { statusOnly: true }
      )
    }
  })
}

export const botToolRedirectUri = (port: number): string =>
  `http://127.0.0.1:${port}${BOT_TOOL_CALLBACK_PATH}`

/**
 * Begins `flow`'s attempt for `redirectUri`, keeping why it couldn't start on the tool's status, or
 * clearing that once it does. Throws `BotToolSignInError`; an ended flow throws why it ended.
 */
export async function beginFlowSignIn(
  key: BotToolOAuthKey,
  flow: BotToolSignInFlow,
  begun: { url: string; grant: number },
  redirectUri: string
): Promise<BotToolSignInAttempt> {
  const { signal } = flow.controller
  const attempt = await beginBotToolSignIn(key, { redirectUri, signal }).catch(
    async (error: unknown) => {
      const code = signal.aborted ? endedBy(signal) : failureOf(error)
      if (code === 'unsupported' || code === 'unavailable') {
        await keepProblem(key, flow, begun, code === 'unsupported' ? 'unsupported' : 'unreachable')
      }
      throw new BotToolSignInError(code)
    }
  )
  await keepProblem(key, flow, begun, undefined)
  if (signal.aborted) {
    attempt.cancel()
    throw new BotToolSignInError(endedBy(signal))
  }
  flow.progress = {
    state: 'waiting',
    attemptId: attempt.id,
    authorizationOrigin: new URL(attempt.authorizationUrl).origin,
    expiresAt: attempt.expiresAt
  }
  return attempt
}

/** Why a flow's signal ended it: replaced, its tool gone, expired, or (no reason) cancelled. */
export const endedBy = (signal: AbortSignal): BotToolSignInFailure =>
  signal.reason instanceof BotToolSignInError ? signal.reason.code : 'cancelled'

/**
 * Serves `flow`'s return on this host's 127.0.0.1 and begins its attempt for that address; answers
 * once the page is ready to open. The listener holds its page until `finish` settles, closes at the
 * deadline or when the flow ends, and never reserves its port as Orca's, so a page Orca's browser
 * routes to this host from another device reaches it. Throws `BotToolSignInError`.
 */
export async function serveFlowSignIn(
  key: BotToolOAuthKey,
  flow: BotToolSignInFlow,
  entry: { url: string; grant: number },
  finish: (
    attempt: BotToolSignInAttempt,
    query: URLSearchParams
  ) => Promise<BotToolSignInFailure | null>
): Promise<BotToolSignInAttempt> {
  let attempt: BotToolSignInAttempt | null = null
  const { signal } = flow.controller
  signal.addEventListener('abort', () => attempt?.cancel(), { once: true })
  const opened = Promise.withResolvers<BotToolSignInAttempt>()
  const returned = serveLoopbackCallback<URLSearchParams>({
    path: BOT_TOOL_CALLBACK_PATH,
    timeoutMs: ATTEMPT_TTL_MS,
    errors: FLOW_ERRORS,
    signal,
    // Only this attempt's `state` is its return; any other hit ends nothing.
    read: (url) =>
      attempt?.owns(url.searchParams)
        ? { kind: 'accept', value: url.searchParams }
        : { kind: 'stray', message: 'Nothing to finish here. Return to Orca.' },
    successPage: {
      received: orcaCallbackReceivedPage(),
      finish: async (query) => outcomePage(await finish(attempt!, query))
    },
    onListening: async (port) => {
      attempt = await beginFlowSignIn(key, flow, entry, botToolRedirectUri(port))
      opened.resolve(attempt)
    }
  })
  returned.catch((error: unknown) => {
    if (flow.progress.state !== 'done' && flow.progress.state !== 'failed') {
      flow.progress = { state: 'failed', code: failureOf(error) }
    }
  })
  const ready = await Promise.race([opened.promise, returned.then(() => null)]).catch(
    (error: unknown) => {
      throw new BotToolSignInError(failureOf(error))
    }
  )
  if (!ready) {
    throw new BotToolSignInError('refused')
  }
  return ready
}

/**
 * Starts a sign-in to the tool in the desktop browser; any earlier Connect for it ends. Answers
 * once the browser is open. Throws `BotToolSignInError`.
 */
export async function connectBotToolSignIn(
  key: BotToolOAuthKey
): Promise<{ attemptId: string; authorizationOrigin: string }> {
  const open = openBrowser
  if (!open) {
    throw new BotToolSignInError('desktop-only')
  }
  const entry = readBotToolOAuth(key.folder, key.credentialId)
  if (!entry) {
    throw new BotToolSignInError('no-tool')
  }
  const flow = claimBotToolSignIn(key)
  const attempt = await serveFlowSignIn(key, flow, entry, (begun, query) =>
    completeFlowSignIn(flow, begun, query)
  )
  try {
    await open(attempt.authorizationUrl)
  } catch (error) {
    flow.controller.abort()
    throw new BotToolSignInError(failureOf(error))
  }
  return { attemptId: attempt.id, authorizationOrigin: new URL(attempt.authorizationUrl).origin }
}

/** How the tool's latest Connect stands; idle when none ran since Orca started. */
export function botToolSignInProgress(key: BotToolOAuthKey): BotToolSignInProgress {
  return flows.get(flowKey(key))?.progress ?? { state: 'idle' }
}

/** Ends the tool's Connect if it still waits on the browser. */
export function cancelBotToolSignIn(key: BotToolOAuthKey, attemptId?: string): void {
  const flow = flows.get(flowKey(key))
  if (
    flow &&
    !flow.completing &&
    (attemptId === undefined ||
      (flow.progress.state === 'waiting' && flow.progress.attemptId === attemptId))
  ) {
    flow.controller.abort()
  }
}
