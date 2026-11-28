import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AcpHostBackendInput } from '../acp/launch/acp-launch-contract'
import { AcpAuthRequiredError } from '../acp/transport/acp-errors'
import {
  antigravityAgySignIn,
  lastAntigravityAgySignedOut,
  noteAgyLoginChanged
} from './antigravity-chat-route'
import { antigravityChatSignIn } from './antigravity-chat-account'
import { forgetAntigravityHostAcpChecks } from './antigravity-host-acp'

// agy's keychain item exists: the login is there, whatever one session request answers.
vi.mock('./agy-credential-presence', () => ({ agyCredentialPresence: async () => 'present' }))

/** How agy answers each session listing, in order; the last repeats. */
const answers: ('authRequired' | 'ok' | 'unanswered')[] = []
let listings = 0

vi.mock('./antigravity-acp-runtime-probe', () => ({
  initializeAntigravityAcp: async (
    _launch: unknown,
    _timeoutMs: number,
    _signal: AbortSignal | undefined,
    check: (connection: unknown, initialized: unknown, folder: string) => Promise<void>
  ) => {
    const initialized = {
      protocolVersion: 1,
      agentInfo: { name: 'Antigravity ACP Server', version: '1.5.17' },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {} },
        _meta: { antigravity: { systemPrompt: { append: true } } }
      }
    }
    const listSessions = async () => {
      const answer = answers[Math.min(listings, answers.length - 1)]
      listings += 1
      // agy's own log in the incident: "Keyring LoadStoredToken timed out after 5s, falling back
      // to file storage", then "Please sign in".
      if (answer === 'authRequired') {
        throw new AcpAuthRequiredError('Authentication required')
      }
      if (answer === 'unanswered') {
        throw new Error('agy acp did not answer in time')
      }
      return { sessions: [] }
    }
    await check({ listSessions }, initialized, tmpdir())
    return initialized
  }
}))

const input: AcpHostBackendInput = {
  command: process.execPath,
  homePath: tmpdir(),
  env: {},
  envToDelete: [],
  stateDirectory: tmpdir(),
  settings: { antigravityChatAuth: { method: 'oauth-personal' } },
  startsProgram: true
}

const start = Date.parse('2026-11-27T21:56:29Z')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(start)
  answers.length = 0
  listings = 0
})

afterEach(() => {
  forgetAntigravityHostAcpChecks()
  vi.useRealTimers()
})

const atSeconds = (seconds: number) => vi.setSystemTime(start + seconds * 1000)

/** agy's sign-in as each check finds it, one check per time given. */
async function checksAt(...times: number[]) {
  const seen = []
  for (const seconds of times) {
    atSeconds(seconds)
    seen.push(await antigravityAgySignIn(input))
  }
  return seen
}

// Incident replay: one "Please sign in" while the keychain timed out held the chat as signed out.
it('does not hold chats as signed out on one auth-required answer', async () => {
  answers.push('authRequired')
  expect(await antigravityAgySignIn(input)).not.toBe('signedOut')
  expect(lastAntigravityAgySignedOut()).not.toBe(true)
  // Every surface that offers "Sign in with Google" reads this published answer.
  expect(antigravityChatSignIn.get().value.auth).not.toBe('signedOut')
})

it('never reads signed out from a burst of auth-required answers under a minute apart, then reads signed in', async () => {
  answers.push('authRequired', 'authRequired', 'authRequired', 'authRequired', 'ok')
  const seen = await checksAt(0, 8, 27, 50, 55)
  expect(seen.slice(0, 4)).not.toContain('signedOut')
  expect(seen[4]).toBe('signedIn')
  expect(lastAntigravityAgySignedOut()).toBe(false)
})

it('never reads signed out when successes come between the auth-required answers', async () => {
  // The incident day: failing runs, each followed seconds later by one that authenticated.
  answers.push('authRequired', 'ok', 'authRequired', 'ok', 'authRequired')
  // A success is kept five minutes; past that, every check asks agy again.
  const seen = await checksAt(0, 8, 320, 327, 640)
  expect(seen).not.toContain('signedOut')
})

it('reads a revoked login as signed out once two answers stand a minute apart', async () => {
  answers.push('authRequired')
  const seen = await checksAt(0, 20, 61)
  expect(seen.slice(0, 2)).not.toContain('signedOut')
  expect(seen[2]).toBe('signedOut')
  expect(lastAntigravityAgySignedOut()).toBe(true)
  expect(antigravityChatSignIn.get().value.auth).toBe('signedOut')
})

it('never pairs answers more than ten minutes apart', async () => {
  answers.push('authRequired')
  const seen = await checksAt(0, 11 * 60)
  expect(seen).not.toContain('signedOut')
})

it('starts over after the login changes', async () => {
  answers.push('authRequired')
  await checksAt(0)
  noteAgyLoginChanged()
  expect(await checksAt(61)).not.toContain('signedOut')
})

it('asks agy again on every check while it is not ready, and keeps only a ready answer', async () => {
  answers.push('authRequired', 'authRequired', 'ok')
  await checksAt(0, 1)
  expect(listings).toBe(2)
  await checksAt(2, 30)
  expect(listings).toBe(3)
})

it('logs the load average and concurrent agent starts when agy does not answer', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  answers.push('unanswered')
  expect(await antigravityAgySignIn(input)).toBe('unknown')
  const logged = warn.mock.calls.find((call) => String(call[0]).includes('[agent-readiness]'))
  expect(logged?.[1]).toMatchObject({
    what: 'probe',
    loadAverage: expect.any(Array),
    agentStartsInFlight: expect.any(Number)
  })
  warn.mockRestore()
})
