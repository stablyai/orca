import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createAgentReadiness,
  type ReadinessAdapter,
  type ReadinessProbeAnswer,
  type ReadinessStoreAnswer
} from './agent-readiness'
import { beginAgentStart } from './agent-start-activity'

// Incident: 2026-11-27 13:56:29 PT, agy's keychain read timed out under host load, agy printed
// "Please sign in", and one such answer was taken as signed out for 9.5 h.
const START = Date.parse('2026-11-27T21:56:29Z')
let now = START
const at = (seconds: number) => {
  now = START + seconds * 1000
}

/** An adapter whose store and probe answer in order, the last answer repeating. */
function scripted(store: ReadinessStoreAnswer[] | null, probe: ReadinessProbeAnswer[] | null) {
  const calls = { store: 0, probe: 0 }
  const pick = <T>(list: T[], index: number) => list[Math.min(index, list.length - 1)]
  const adapter: ReadinessAdapter = {
    ...(store ? { store: async () => pick(store, calls.store++) } : {}),
    ...(probe ? { probe: async () => pick(probe, calls.probe++) } : {})
  }
  return { adapter, calls }
}

const present: ReadinessStoreAnswer = { kind: 'present' }
const absent: ReadinessStoreAnswer = { kind: 'absent' }
const authRequired: ReadinessProbeAnswer = { kind: 'auth_required' }
const ok: ReadinessProbeAnswer = { kind: 'ok' }
const timedOut: ReadinessProbeAnswer = { kind: 'unknown', reason: 'timeout' }
const unanswered: ReadinessProbeAnswer = { kind: 'unknown', reason: 'unanswered' }

function readiness(adapter: ReadinessAdapter) {
  return createAgentReadiness({ now: () => now, adapters: { antigravity: adapter } })
}

beforeEach(() => {
  now = START
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('acceptance 1: four "Please sign in" answers inside two minutes, then success, never read as signed out', async () => {
  const { adapter } = scripted(
    [present],
    [authRequired, authRequired, authRequired, authRequired, ok]
  )
  const ready = readiness(adapter)
  const states = []
  for (const seconds of [0, 8, 27, 90, 110]) {
    at(seconds)
    states.push((await ready.read('antigravity', { caller: 'background', probe: true })).state)
  }
  expect(states).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'ready'])
})

it('acceptance 1: a keychain read that timed out is unknown(timeout) checked with the keychain, never signed out', async () => {
  const { adapter } = scripted([{ kind: 'unknown', reason: 'timeout', checkedWith: 'keychain' }], null)
  const result = await readiness(adapter).read('antigravity', { caller: 'foreground', probe: false })
  expect(result).toMatchObject({ state: 'unknown', reason: 'timeout', checkedWith: 'keychain' })
})

it('names the probe, never the keychain, for a probe that timed out or did not answer', async () => {
  const timed = await readiness(scripted([present], [timedOut]).adapter).read('antigravity', {
    caller: 'background',
    probe: true
  })
  expect(timed).toMatchObject({ state: 'unknown', reason: 'timeout', checkedWith: 'probe' })
  const silent = await readiness(scripted([present], [unanswered]).adapter).read('antigravity', {
    caller: 'background',
    probe: true
  })
  expect(silent).toMatchObject({ state: 'unknown', reason: 'unanswered', checkedWith: 'probe' })
})

it('acceptance 2: a credential deleted from the store reads signed out after one store read, with the sign-in step', async () => {
  const { adapter, calls } = scripted([absent], [ok])
  const result = await readiness(adapter).read('antigravity', { caller: 'background', probe: true })
  expect(result).toMatchObject({ state: 'signed_out', evidence: 'store_absent' })
  expect(result.state === 'signed_out' && result.signInInstruction).toMatch(/agy/)
  expect(calls).toEqual({ store: 1, probe: 0 })
})

it('acceptance 3: an expired token reads signed out once three auth-required answers span two minutes', async () => {
  const { adapter } = scripted([present], [authRequired])
  const ready = readiness(adapter)
  const seen = []
  for (const seconds of [0, 61, 121]) {
    at(seconds)
    seen.push(await ready.read('antigravity', { caller: 'background', probe: true }))
  }
  expect(seen[0]).toMatchObject({
    state: 'unknown',
    reason: 'auth_required_unconfirmed',
    authRequiredCount: 1
  })
  expect(seen[1]).toMatchObject({ state: 'unknown', authRequiredCount: 2 })
  expect(seen[2]).toMatchObject({ state: 'signed_out', evidence: 'repeated_auth_required' })
})

it('keeps three auth-required answers inside 119 s unconfirmed', async () => {
  const { adapter } = scripted([present], [authRequired])
  const ready = readiness(adapter)
  let last
  for (const seconds of [0, 60, 119]) {
    at(seconds)
    last = await ready.read('antigravity', { caller: 'background', probe: true })
  }
  expect(last).toMatchObject({ state: 'unknown', authRequiredCount: 3 })
})

it('starts the count again after any success', async () => {
  const { adapter } = scripted([present], [authRequired, authRequired, ok, authRequired])
  const ready = readiness(adapter)
  const states = []
  // Ready is kept for a minute, so the last read comes after that and asks again.
  for (const seconds of [0, 61, 130, 200]) {
    at(seconds)
    states.push(await ready.read('antigravity', { caller: 'background', probe: true }))
  }
  expect(states.map((state) => state.state)).toEqual(['unknown', 'unknown', 'ready', 'unknown'])
  expect(states[3]).toMatchObject({ authRequiredCount: 1 })
})

it('never counts a timed-out probe toward signed out', async () => {
  const { adapter } = scripted([present], [timedOut])
  const ready = readiness(adapter)
  let last
  for (const seconds of [0, 61, 121, 181]) {
    at(seconds)
    last = await ready.read('antigravity', { caller: 'background', probe: true })
  }
  expect(last).toMatchObject({ state: 'unknown', reason: 'timeout' })
})

it('acceptance 4: 24 concurrent status reads run at most one store read and one probe', async () => {
  let releaseProbe: () => void = () => {}
  const calls = { store: 0, probe: 0 }
  const adapter: ReadinessAdapter = {
    store: async () => {
      calls.store += 1
      return present
    },
    probe: () => {
      calls.probe += 1
      return new Promise((resolve) => {
        releaseProbe = () => resolve(ok)
      })
    }
  }
  const ready = readiness(adapter)
  const reads = Array.from({ length: 24 }, () => ready.status('antigravity'))
  await vi.waitFor(() => expect(calls.probe).toBe(1))
  releaseProbe()
  const results = await Promise.all(reads)
  expect(results.every((result) => result.state === 'ready')).toBe(true)
  expect(calls).toEqual({ store: 1, probe: 1 })
})

it('status returns at once on ready and retries a timed-out check at most twice', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { adapter, calls } = scripted([present], [timedOut])
  const ready = readiness(adapter)
  const status = ready.status('antigravity')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await status).toMatchObject({ state: 'unknown', reason: 'timeout' })
  expect(calls.probe).toBe(3)
})

it('status does not wait on an unconfirmed sign-in: it answers with when to check again', async () => {
  const { adapter, calls } = scripted([present], [authRequired])
  const result = await readiness(adapter).status('antigravity')
  expect(result).toMatchObject({
    state: 'unknown',
    reason: 'auth_required_unconfirmed',
    checkAgainAfterMs: expect.any(Number)
  })
  expect(calls.probe).toBe(1)
})

it('takes a recent successful turn on the same account home as ready, with no probe', async () => {
  const { adapter, calls } = scripted([present], [authRequired])
  const ready = readiness(adapter)
  ready.noteAgentOutput('antigravity', { accountHome: null })
  at(9 * 60)
  expect(await ready.read('antigravity', { caller: 'background', probe: true })).toMatchObject({
    state: 'ready',
    evidence: 'recent_output'
  })
  expect(calls).toEqual({ store: 0, probe: 0 })
  // Older than ten minutes proves nothing about now.
  at(11 * 60)
  expect((await ready.read('antigravity', { caller: 'background', probe: true })).state).not.toBe(
    'ready'
  )
})

it('does not take a success on another account home as evidence for this one', async () => {
  const { adapter, calls } = scripted([present], [authRequired])
  const ready = readiness(adapter)
  ready.noteAgentOutput('antigravity', { accountHome: '/Users/me/Library/orca/accounts/work' })
  const result = await ready.read('antigravity', { caller: 'background', probe: true })
  expect(result.state).not.toBe('ready')
  expect(calls.probe).toBe(1)
})

it('counts a worker failure that asked to sign in as one auth-required answer', async () => {
  const { adapter } = scripted([present], [authRequired])
  const ready = readiness(adapter)
  ready.noteAuthRequired('antigravity')
  at(61)
  ready.noteAuthRequired('antigravity')
  at(121)
  expect(await ready.read('antigravity', { caller: 'background', probe: true })).toMatchObject({
    state: 'signed_out',
    evidence: 'repeated_auth_required'
  })
})

it('keeps a signed-out answer for at most a minute', async () => {
  const { adapter, calls } = scripted([absent, present], [ok])
  const ready = readiness(adapter)
  expect((await ready.read('antigravity', { caller: 'background', probe: true })).state).toBe(
    'signed_out'
  )
  at(30)
  expect((await ready.read('antigravity', { caller: 'background', probe: true })).state).toBe(
    'signed_out'
  )
  at(61)
  expect((await ready.read('antigravity', { caller: 'background', probe: true })).state).toBe(
    'ready'
  )
  expect(calls.store).toBe(2)
})

it('answers unknown(no_check) for an agent Orca has no check for', async () => {
  const ready = createAgentReadiness({ now: () => now, adapters: {} })
  expect(await ready.read('codex', { caller: 'background', probe: true })).toMatchObject({
    state: 'unknown',
    reason: 'no_check'
  })
})

it('logs the load average and concurrent agent starts when a probe times out', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const end = beginAgentStart()
  try {
    const { adapter } = scripted([present], [timedOut])
    await readiness(adapter).read('antigravity', { caller: 'background', probe: true })
  } finally {
    end()
  }
  const logged = warn.mock.calls.find((call) => String(call[0]).includes('[agent-readiness]'))
  expect(logged?.[1]).toMatchObject({
    what: 'probe',
    agent: 'antigravity',
    loadAverage: expect.any(Array),
    agentStartsInFlight: 1
  })
})
