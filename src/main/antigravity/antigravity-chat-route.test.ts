import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AgyCredentialPresence } from './agy-credential-presence'

const agy = vi.hoisted(
  (): {
    presence: AgyCredentialPresence
    session: ReturnType<typeof vi.fn>
    compatible: ReturnType<typeof vi.fn>
  } => ({
    presence: 'present',
    session: vi.fn(async () => 'ready'),
    compatible: vi.fn(async (..._args: unknown[]) => 'ready')
  })
)
vi.mock('./agy-credential-presence', () => ({ agyCredentialPresence: async () => agy.presence }))
vi.mock('./antigravity-host-acp', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkAntigravityHostAcp: agy.session,
  checkAntigravityHostAcpCompatible: agy.compatible
}))

const { antigravityAgySignIn } = await import('./antigravity-chat-route')

const input = (command: string, startsProgram = false) => ({
  command,
  env: {},
  envToDelete: [],
  homePath: '/home/u',
  stateDirectory: '/data',
  settings: {},
  startsProgram
})

beforeEach(() => {
  agy.session.mockClear()
  agy.compatible.mockClear()
})

describe("agy's sign-in as Settings reads it", () => {
  it('is not installed before any agy resolves', async () => {
    expect(await antigravityAgySignIn(input('agy'))).toBe('notInstalled')
  })

  it('asks a session of agy only where a login is there to find', async () => {
    agy.presence = 'present'
    expect(await antigravityAgySignIn(input('/bin/agy'))).toBe('signedIn')
    expect(agy.session).toHaveBeenCalledOnce()
  })

  it('without a login, asks only whether agy can serve chats, started only by someone using it', async () => {
    agy.presence = 'absent'
    expect(await antigravityAgySignIn(input('/bin/agy', true))).toBe('signedOut')
    expect(agy.session).not.toHaveBeenCalled()
    expect(agy.compatible).toHaveBeenLastCalledWith('/bin/agy', {}, [], { start: true })
    await antigravityAgySignIn(input('/bin/agy'))
    expect(agy.compatible).toHaveBeenLastCalledWith('/bin/agy', {}, [], { start: false })
  })

  it('never claims signed out behind a locked keyring', async () => {
    agy.presence = 'locked'
    expect(await antigravityAgySignIn(input('/bin/agy', true))).toBe('unknown')
    expect(agy.session).not.toHaveBeenCalled()
  })
})
