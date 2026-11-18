// The host object as its own director: the epoch rules (director-removal.md §3) and the object's
// answers for assign, resume and invite, on a real object store (node:sqlite).
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { RelayCredentialStore, hashCredential } from '../../relay/src/credentials/credential-store'
import { planDirectorAssign } from '../src/director-assign'
import { DIRECTOR_URL_KEY } from '../src/host-relay-director'
import { EDGE_URL, FRONT_DOOR_URL, baseEnv, hostNamespace, stubObjectGlobals } from './director-fixture'

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown
    ) {}
  }
}))
const { HostRelay } = await import('../src/host-relay')

const HOST = 'AbCdEfGhIjKlMnOp'
const USER = 'user-1'
const CELL = 'edge'
const ask = (cellUrl = EDGE_URL, userId = USER) => ({ userId, relayHostId: HOST, cellUrl })
const stored = (epoch: number, over: Partial<{ userId: string; cellId: string }> = {}) => ({ userId: USER, relayHostId: HOST, cellId: CELL, assignmentEpoch: epoch, ...over })

describe('director assign epoch rules', () => {
  const plan = (input: Partial<Parameters<typeof planDirectorAssign>[0]>) =>
    planDirectorAssign({ current: null, handedUrl: undefined, frozen: false, cellId: CELL, ask: ask(), ...input })

  it('keeps the epoch of a legacy push (no URL recorded): both URLs reach this object', () => {
    expect(plan({ current: stored(4), ask: ask(FRONT_DOOR_URL) })).toEqual({ outcome: 'assign', assignmentEpoch: 4, write: null })
  })

  it('another account on the same machine gets a newer epoch and none of the earlier data', () => {
    expect(plan({ current: stored(4), handedUrl: EDGE_URL, ask: ask(EDGE_URL, 'user-2') })).toEqual({ outcome: 'assign', assignmentEpoch: 5, write: { wipe: true } })
  })

  it('never takes a host placed elsewhere, nor one frozen for a move', () => {
    expect(plan({ current: stored(4, { cellId: 'us-c1' }) })).toEqual({ outcome: 'elsewhere' })
    expect(plan({ current: stored(4), frozen: true })).toEqual({ outcome: 'frozen' })
  })
})

describe('HostRelay as the director', () => {
  beforeAll(stubObjectGlobals)
  const setup = (backend = 'object') => {
    const env: Record<string, unknown> = { ...baseEnv('{"keys":[]}'), EDGE_BACKEND: backend, SPIKE_DEBUG: '1' }
    const hosts = hostNamespace((ctx) => new HostRelay(ctx, env))
    env.HOST_RELAY = hosts.namespace
    const relay = hosts.namespace.get(HOST)
    const state = hosts.objects.get(HOST)!.state
    const store = () => new RelayCredentialStore(relay['store'].database)
    return { relay, state, store }
  }

  it('answers an epoch the host hello then accepts, and keeps it across asks', async () => {
    const { relay, state } = setup()
    expect(await relay.directorAssign(ask())).toEqual({ outcome: 'assigned', cellUrl: EDGE_URL, assignmentEpoch: 1 })
    expect(await relay.directorAssign(ask())).toEqual({ outcome: 'assigned', cellUrl: EDGE_URL, assignmentEpoch: 1 })
    expect(state.kv.get(DIRECTOR_URL_KEY)).toBe(EDGE_URL)
    expect(await relay['store'].verifyAssignment(USER, HOST, 1)).toBe(true)
    // A URL change: the old epoch no longer passes hello (WRONG_CELL, the desktop re-asks).
    expect(await relay.directorAssign(ask(FRONT_DOOR_URL))).toEqual({ outcome: 'assigned', cellUrl: FRONT_DOOR_URL, assignmentEpoch: 2 })
    expect(await relay['store'].verifyAssignment(USER, HOST, 1)).toBe(false)
    expect(await relay['store'].verifyAssignment(USER, HOST, 2)).toBe(true)
  })

  it('refuses a host the legacy director placed on another cell, and answers nothing on other backends', async () => {
    const { relay } = setup()
    await relay['store'].applyAssignment({ userId: USER, relayHostId: HOST, cellId: 'us-c1', assignmentEpoch: 3 })
    expect(await relay.directorAssign(ask())).toEqual({ outcome: 'elsewhere' })
    expect(await setup('spike').relay.directorAssign(ask())).toEqual({ outcome: 'unavailable' })
  })

  it('verifies resume tokens and invites with the URL it handed out', async () => {
    const { relay, store } = setup()
    await relay.directorAssign(ask(FRONT_DOOR_URL))
    const invite = await store().createInvite({ userId: USER, relayHostId: HOST }, 'phone-1')
    const inviteBody = { relayHostId: HOST, kind: 'invite' as const, tokenHash: hashCredential(invite.inviteToken) }
    expect(await relay.directorVerify(inviteBody, EDGE_URL)).toEqual({ outcome: 'verified', cellUrl: FRONT_DOOR_URL, assignmentEpoch: 1 })
    // An invite is never a resume token.
    expect(await relay.directorVerify({ ...inviteBody, kind: 'resume' }, EDGE_URL)).toEqual({ outcome: 'none' })
    expect(await relay.directorVerify({ ...inviteBody, tokenHash: hashCredential('B'.repeat(43)) }, EDGE_URL)).toEqual({ outcome: 'none' })
  })

  it('a legacy-pushed host is answered with the fallback URL', async () => {
    const { relay, store } = setup()
    await relay['store'].applyAssignment({ userId: USER, relayHostId: HOST, cellId: CELL, assignmentEpoch: 6 })
    const invite = await store().createInvite({ userId: USER, relayHostId: HOST }, 'phone-1')
    expect(await relay.directorVerify({ relayHostId: HOST, kind: 'invite', tokenHash: hashCredential(invite.inviteToken) }, EDGE_URL)).toEqual({
      outcome: 'verified',
      cellUrl: EDGE_URL,
      assignmentEpoch: 6
    })
  })

  it('an object that never held a host answers not_here and creates no storage', async () => {
    const { relay, state } = setup()
    expect(await relay.directorVerify({ relayHostId: HOST, kind: 'resume', tokenHash: hashCredential('A'.repeat(43)) }, EDGE_URL)).toEqual({ outcome: 'not_here' })
    expect(state.tables()).toBe(0)
    expect(state.kv.size).toBe(0)
  })
})
