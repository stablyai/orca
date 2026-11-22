// Orca's own sign-in to a bot's app, run on the bot's host for the device that asked. A paired
// desktop opens the page in Orca's browser routed to this host, so the app returns to this host's own
// listener; a phone, the web or the CLI pastes the address its browser ended on and sends only its
// query. Tokens and the PKCE verifier never leave this host.
import { randomInt, randomUUID } from 'node:crypto'
import type {
  BotToolSignInAttemptView,
  BotToolSignInFailure
} from '../../../shared/bot-tool-sign-in'
import { readBotToolOAuth } from '../bot-tool-credentials'
import { BotToolSignInError, now, type BotToolOAuthKey } from './bot-tool-oauth'
import type { BotToolSignInAttempt } from './bot-tool-oauth-sign-in'
import {
  BOT_TOOL_CALLBACK_PATH,
  beginFlowSignIn,
  botToolRedirectUri,
  claimBotToolSignIn,
  completeFlowSignIn,
  endedBy,
  failureOf,
  serveFlowSignIn,
  type BotToolSignInFlow
} from './bot-tool-sign-in-flows'

/** `routed`: this host listens for the return; `paste`: the device sends back the returned query. */
export type BotToolSignInMode = 'routed' | 'paste'

// Keep long polls inside typical RPC deadlines.
const WAIT_MS = 20_000
/** A settled attempt stays readable this long, so a device whose reply was lost still learns how it went. */
const KEEP_SETTLED_MS = 60_000
const NOT_ACTIVE = 'This sign-in is no longer active on this device. Start again.'
const ALREADY_USED = 'This sign-in was already used.'
const NOT_THIS_SIGN_IN =
  'That address isn’t this sign-in’s return. Paste the whole address the page ended on.'

type Pending = {
  /** The device that started it (`rpcCallerOperationKey`); only it may wait, finish or cancel. */
  owner: string
  flow: BotToolSignInFlow
  /** Null for a start that failed. */
  attempt: BotToolSignInAttempt | null
  view: BotToolSignInAttemptView
  listeners: Set<() => void>
  expiry?: ReturnType<typeof setTimeout>
}

const attempts = new Map<string, Pending>()

/**
 * A paste's return address: the loopback address the tool's registration was made for, so a paste
 * doesn't register Orca with the app again (nobody listens there), else a random port.
 */
function pasteRedirect(stored: string | undefined): string {
  let reused: URL | null = null
  try {
    reused = stored ? new URL(stored) : null
  } catch {
    reused = null
  }
  return reused?.protocol === 'http:' &&
    reused.hostname === '127.0.0.1' &&
    reused.port &&
    reused.pathname === BOT_TOOL_CALLBACK_PATH &&
    !reused.search
    ? reused.href
    : botToolRedirectUri(randomInt(49_152, 65_536))
}

function change(pending: Pending, next: BotToolSignInAttemptView): void {
  pending.view = { ...next, revision: pending.view.revision + 1 }
  for (const listener of pending.listeners) {
    listener()
  }
}

function settle(pending: Pending, outcome: { code: BotToolSignInFailure } | null): void {
  const { flowId, expiresAt, state } = pending.view
  if (state === 'done' || state === 'failed') {
    return
  }
  clearTimeout(pending.expiry)
  pending.flow.progress = outcome ? { state: 'failed', code: outcome.code } : { state: 'done' }
  change(
    pending,
    outcome
      ? { flowId, revision: 0, expiresAt, state: 'failed', code: outcome.code }
      : { flowId, revision: 0, expiresAt, state: 'done' }
  )
  setTimeout(() => attempts.delete(flowId), KEEP_SETTLED_MS).unref?.()
}

/**
 * Starts a sign-in to the tool for `owner`, ending any open one for it from any device (the newest
 * start wins). Answers once the page is ready to open, or with why it couldn't start ("This app
 * isn't supported yet" is `unsupported`).
 */
export async function startBotToolSignInAttempt(
  owner: string,
  key: BotToolOAuthKey,
  mode: BotToolSignInMode
): Promise<BotToolSignInAttemptView> {
  const entry = readBotToolOAuth(key.folder, key.credentialId)
  if (!entry) {
    throw new BotToolSignInError('no-tool')
  }
  const flow = claimBotToolSignIn(key)
  let pending: Pending | null = null
  let attempt: BotToolSignInAttempt
  try {
    attempt =
      mode === 'routed'
        ? await serveFlowSignIn(key, flow, entry, (_attempt, query) =>
            pending ? finishPending(pending, query) : Promise.resolve('refused' as const)
          )
        : await beginFlowSignIn(key, flow, entry, pasteRedirect(entry.record.redirectUri))
  } catch (error) {
    const flowId = randomUUID()
    const view = {
      flowId,
      revision: 1,
      expiresAt: now(),
      state: 'failed' as const,
      code: failureOf(error)
    }
    attempts.set(flowId, { owner, flow, attempt: null, view, listeners: new Set() })
    setTimeout(() => attempts.delete(flowId), KEEP_SETTLED_MS).unref?.()
    return view
  }
  const { signal } = flow.controller
  const started: Pending = {
    owner,
    flow,
    attempt,
    view: {
      flowId: attempt.id,
      revision: 1,
      expiresAt: attempt.expiresAt,
      state: 'waiting',
      authorizationUrl: attempt.authorizationUrl,
      redirectUri: attempt.redirectUri
    },
    listeners: new Set()
  }
  pending = started
  attempts.set(attempt.id, started)
  // A newer start, the tool's removal, a URL edit or the bot's deletion ends it; while the code is
  // being exchanged, the exchange reports how that ended.
  signal.addEventListener(
    'abort',
    () => {
      attempt.cancel()
      if (!flow.completing) {
        settle(started, { code: endedBy(signal) })
      }
    },
    { once: true }
  )
  started.expiry = setTimeout(
    () => {
      if (!flow.completing) {
        flow.controller.abort(new BotToolSignInError('expired'))
      }
    },
    Math.max(0, attempt.expiresAt - now())
  )
  started.expiry.unref?.()
  return started.view
}

/** Spends the attempt on a returned query, from either path; resolves with why it failed, or null. */
async function finishPending(
  pending: Pending,
  query: URLSearchParams
): Promise<BotToolSignInFailure | null> {
  const { attempt, flow, view } = pending
  if (view.state !== 'waiting' || !attempt) {
    return 'superseded'
  }
  change(pending, {
    flowId: view.flowId,
    revision: 0,
    expiresAt: view.expiresAt,
    state: 'finishing'
  })
  const failure = await completeFlowSignIn(flow, attempt, query)
  settle(pending, failure ? { code: failure } : null)
  return failure
}

function own(owner: string, flowId: string): Pending {
  const pending = attempts.get(flowId)
  if (!pending || pending.owner !== owner) {
    throw new Error(NOT_ACTIVE)
  }
  return pending
}

/** The attempt as it stands once its revision passes `afterRevision`, it settles, or a while passes. */
export async function waitBotToolSignInAttempt(
  owner: string,
  flowId: string,
  afterRevision: number,
  signal?: AbortSignal
): Promise<BotToolSignInAttemptView> {
  const pending = own(owner, flowId)
  const { state, revision } = pending.view
  if (revision > afterRevision || state === 'done' || state === 'failed') {
    return pending.view
  }
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      pending.listeners.delete(done)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, WAIT_MS)
    pending.listeners.add(done)
    signal?.addEventListener('abort', done, { once: true })
  })
  return pending.view
}

/**
 * Finishes from the query the device's browser returned with; the host builds the callback from the
 * address it fixed for the attempt and never fetches one a client gives. A query that isn't this
 * attempt's is refused and spends nothing; the first that is spends it. Resolves once settled.
 */
export async function finishBotToolSignInAttempt(
  owner: string,
  flowId: string,
  queryText: string
): Promise<BotToolSignInAttemptView> {
  const pending = own(owner, flowId)
  const { view } = pending
  if (view.state === 'failed') {
    throw new BotToolSignInError(view.code)
  }
  if (view.state !== 'waiting' || !pending.attempt) {
    throw new Error(ALREADY_USED)
  }
  const query = new URLSearchParams(queryText.replace(/^\?/, ''))
  if (!pending.attempt.owns(query)) {
    throw new Error(NOT_THIS_SIGN_IN)
  }
  await finishPending(pending, query)
  return pending.view
}

/** Ends the attempt unless its code is already being exchanged; answers how it stands. */
export function cancelBotToolSignInAttempt(
  owner: string,
  flowId: string
): BotToolSignInAttemptView {
  const pending = own(owner, flowId)
  const { state } = pending.view
  if (state !== 'done' && state !== 'failed' && !pending.flow.completing) {
    pending.flow.controller.abort(new BotToolSignInError('cancelled'))
  }
  return pending.view
}
