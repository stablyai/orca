import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AcpHostBackendInput } from '../acp/launch/acp-launch-contract'
import { AcpAuthRequiredError } from '../acp/transport/acp-errors'
import { antigravityAgySignIn, lastAntigravityAgySignedOut } from './antigravity-chat-route'
import { antigravityChatSignIn } from './antigravity-chat-account'
import { forgetAntigravityHostAcpChecks } from './antigravity-host-acp'

// agy's keychain item exists: the login is there, whatever one session request answers.
vi.mock('./agy-credential-presence', () => ({ agyCredentialPresence: async () => 'present' }))

/** How agy answers each session listing, in order; the last repeats. */
const answers: ('authRequired' | 'ok')[] = []
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

// Incident replay: one "Please sign in" while the keychain timed out held the chat as signed out.
it('does not hold chats as signed out on one auth-required answer', async () => {
  answers.push('authRequired')
  expect(await antigravityAgySignIn(input)).not.toBe('signedOut')
  expect(lastAntigravityAgySignedOut()).not.toBe(true)
  // Every surface that offers "Sign in with Google" reads this published answer.
  expect(antigravityChatSignIn.get().value.auth).not.toBe('signedOut')
})

it('never reads signed out from four auth-required answers inside two minutes, then reads signed in', async () => {
  answers.push('authRequired', 'authRequired', 'authRequired', 'authRequired', 'ok')
  for (const atSeconds of [0, 8, 27, 90]) {
    vi.setSystemTime(start + atSeconds * 1000)
    expect(await antigravityAgySignIn(input)).not.toBe('signedOut')
    expect(lastAntigravityAgySignedOut()).not.toBe(true)
  }
  vi.setSystemTime(start + 150_000)
  expect(await antigravityAgySignIn(input)).toBe('signedIn')
})

it('reads signed out once three auth-required answers span two minutes', async () => {
  answers.push('authRequired')
  const seen = []
  for (const atSeconds of [0, 61, 121]) {
    vi.setSystemTime(start + atSeconds * 1000)
    seen.push(await antigravityAgySignIn(input))
  }
  expect(seen.slice(0, 2)).not.toContain('signedOut')
  expect(seen[2]).toBe('signedOut')
  expect(lastAntigravityAgySignedOut()).toBe(true)
})
