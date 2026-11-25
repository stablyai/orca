// Signs agy itself in from Orca: `agy acp --login` on this host prints Google's link, which only the
// starting client sees, and reads back the code that client pastes. One flow per host. Its login is
// agy's own, the one terminal agy and every Antigravity chat use.

import { randomUUID } from 'node:crypto'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnProcess } from '@orca/process-host'
import type * as accountTypes from '../../shared/agent-accounts/antigravity/antigravity-account-types'
import { antigravityChatSignIn } from './antigravity-chat-account'
import { agyLoginFailure } from './antigravity-sign-in-failure'
import { agyLoginAnswer, agyLoginLink } from './antigravity-sign-in-url'

// Google's sign-in page stays usable about this long.
const FLOW_DEADLINE_MS = 300_000
const OUTPUT_TAIL_CHARS = 4_000
const NOT_ACTIVE = 'This sign-in is no longer active in this client.'

type Phase = accountTypes.AntigravityChatSignInState['phase']
type Flow = {
  id: string
  owner: string
  intent: accountTypes.AntigravityChatSignInIntent
  ended: AbortController
  done: Promise<void>
  link?: string
  agy?: ChildProcessWithoutNullStreams
  answered?: boolean
}

export type AntigravityChatSignInHost = {
  /** agy and the environment a chat on agy's own home runs it with. */
  agy(signal: AbortSignal): Promise<{ command: string; env: Record<string, string> }>
  /** agy's login changed: whatever vouched for or ran on the previous one reads it again, and an
   *  added account is saved. */
  signedIn(intent: accountTypes.AntigravityChatSignInIntent): void
}

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
  auth?: accountTypes.AntigravityChatAuth
): void {
  const { value } = antigravityChatSignIn.get()
  const shown = value.flow
  if (shown?.flowId !== current.id || settled(shown.phase)) {
    // A flow nothing shows any more can't be waited on: a settling one still stops agy.
    if (settled(next.phase)) {
      current.ended.abort()
    }
    return
  }
  const flow = { ...next, flowId: current.id, owner: current.owner, intent: current.intent }
  antigravityChatSignIn.set({ auth: auth ?? value.auth, flow })
  if (settled(next.phase)) {
    current.ended.abort()
  }
}

export function startAntigravityChatSignIn(
  host: AntigravityChatSignInHost,
  owner: string,
  intent: accountTypes.AntigravityChatSignInIntent = 'signIn'
): accountTypes.AntigravityChatSignInStartResult {
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
  try {
    const failure = await logIn(current, host)
    if (failure === null) {
      publish(current, { phase: 'signedIn' }, 'signedIn')
      host.signedIn(current.intent)
    } else if (!current.ended.signal.aborted) {
      publish(current, { phase: 'failed', error: failure })
    }
  } catch (error) {
    if (!current.ended.signal.aborted) {
      console.warn('[antigravity] agy sign-in failed:', error)
      publish(current, {
        phase: 'failed',
        error: error instanceof Error && error.message ? error.message : agyLoginFailure('')
      })
    }
  } finally {
    clearTimeout(deadline)
    current.ended.abort()
    if (active === current) {
      active = null
    }
  }
}

/** Runs `agy acp --login` to its end: null when it signed in, else what to tell the person. */
async function logIn(current: Flow, host: AntigravityChatSignInHost): Promise<string | null> {
  const { signal } = current.ended
  const { command, env } = await host.agy(signal)
  signal.throwIfAborted()
  const agy = spawnProcess({ program: command, args: ['acp', '--login'], env, stdio: 'pipe' })
  current.agy = agy
  let tail = ''
  let pending = ''
  const read = (chunk: Buffer | string): void => {
    const text = chunk.toString()
    tail = (tail + text).slice(-OUTPUT_TAIL_CHARS)
    pending += text
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      receiveLine(current, line)
    }
  }
  agy.stdout.on('data', read)
  agy.stderr.on('data', read)
  agy.stdin.on('error', () => {})
  const stop = (): void => {
    agy.kill()
  }
  signal.addEventListener('abort', stop, { once: true })
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      agy.once('error', reject)
      agy.once('close', resolve)
    })
    return code === 0 ? null : agyLoginFailure(tail)
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

function receiveLine(current: Flow, line: string): void {
  const link = agyLoginLink(line)
  if (!link || current.ended.signal.aborted) {
    return
  }
  if (current.link) {
    if (link !== current.link) {
      publish(current, {
        phase: 'failed',
        error: 'Antigravity started more than one Google sign-in request.'
      })
    }
    return
  }
  current.link = link
  publish(current, { phase: 'waiting', url: link })
}

function ownFlow(owner: string, flowId: string): Flow {
  const current = active
  if (!running(current) || current.id !== flowId || current.owner !== owner) {
    throw new Error(NOT_ACTIVE)
  }
  return current
}

/** Stops agy and waits for it to exit. */
export async function cancelAntigravityChatSignIn(
  owner: string,
  flowId: string
): Promise<accountTypes.AntigravityChatSignInState | null> {
  const current = ownFlow(owner, flowId)
  publish(current, { phase: 'cancelled' })
  await current.done
  return readAntigravityChatSignInStatus(owner).flow
}

/** Hands agy the code, or the address of the page Google landed on, once per flow. */
export async function completeAntigravityChatSignIn(
  owner: string,
  flowId: string,
  pasted: string
): Promise<accountTypes.AntigravityChatSignInState | null> {
  const current = ownFlow(owner, flowId)
  if (current.answered) {
    throw new Error('That code was already sent. Wait for Antigravity to finish signing in.')
  }
  if (antigravityChatSignIn.get().value.flow?.phase !== 'waiting' || !current.agy) {
    throw new Error('Wait for the Google sign-in link before you paste a code.')
  }
  const answer = agyLoginAnswer(pasted)
  if (!answer) {
    throw new Error(
      'Paste the code Google shows after you sign in, or the address of that page, then try again.'
    )
  }
  current.answered = true
  current.agy.stdin.end(`${answer}\n`)
  publish(current, { phase: 'verifying' })
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
