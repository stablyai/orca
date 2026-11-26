// A desktop paired over Relay only, when the cell it knows stops answering for its credential
// (4409): it asks the Relay director where the host is now, as the phone does, and redials once.
// A director that no longer knows the credential (401) ends the link instead of a redial loop.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayDirectorHttpError } from '../../../../shared/remote-runtime/relay/client/relay-director-resolve'
import type { MobileRelayEndpoint } from '../../../../shared/remote-runtime/relay/mobile-relay-credential-contract'
import { startHostOverRelay } from '../testing/relay-runtime-host.test-fixtures'
import { clearRelayDialHolds } from '../../../ipc/runtime-environments/connections/runtime-environment-relay-link'
import { RelayRuntimeDialMemory } from '../../../../shared/remote-runtime/control/remote-runtime-relay-dial-memory'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

const RELAY_CASE_TIMEOUT_MS = 30_000

describe('a desktop paired over Relay only, when its cell stops answering', () => {
  it(
    'finds the host on the cell the director names, and redials there once',
    async () => {
      const director = { revoked: false, cell: 'cell.test' }
      const resolveRelay = vi.fn(async (input: { relay: MobileRelayEndpoint }) => {
        if (director.revoked) {
          throw new RelayDirectorHttpError(401, null)
        }
        return { ...input.relay, cellUrl: `https://${director.cell}`, assignmentEpoch: 2 }
      })
      const host = await startHostOverRelay(cleanups, { resolveRelay })
      expect((await host.link.request('status.get', { probe: true }, 15_000)).ok).toBe(true)

      // The host moved: its old cell answers 4409 for this credential.
      host.cellState.hostCell = 'cell2.test'
      director.cell = 'cell2.test'
      host.cell.cut()
      await vi.waitFor(
        () => expect(host.entry()?.resume?.relay.cellUrl).toBe('https://cell2.test'),
        {
          timeout: 15_000
        }
      )
      expect((await host.link.request('status.get', { probe: true }, 15_000)).ok).toBe(true)
      expect(resolveRelay).toHaveBeenCalledTimes(1)
      expect(host.cellState.dialedHosts.slice(-2)).toEqual(['cell.test', 'cell2.test'])
    },
    // A real host and cell: each case waits on a few dials over loopback.
    RELAY_CASE_TIMEOUT_MS
  )

  it(
    'stops once the director no longer knows its credential, instead of redialing the cell',
    async () => {
      const resolveRelay = vi.fn(async () => {
        throw new RelayDirectorHttpError(401, null)
      })
      const host = await startHostOverRelay(cleanups, { resolveRelay })
      expect((await host.link.request('status.get', { probe: true }, 15_000)).ok).toBe(true)

      // Revoked: the cell no longer routes the credential (4409), and the director refuses it.
      host.cellState.hostCell = 'nowhere.test'
      host.cell.cut()
      // A call racing the cut fails with the drop; the next hears the credential is gone.
      await vi.waitFor(() => expect(host.entry()?.resume).toBeUndefined(), { timeout: 15_000 })
      await expect(host.link.request('status.get', { probe: true }, 15_000)).rejects.toMatchObject({
        code: 'relay_credential_unavailable'
      })
      expect(host.link.getDiagnostics().state).toBe('closed')
      expect(host.entry()?.resume).toBeUndefined()
      expect(resolveRelay).toHaveBeenCalledTimes(1)
    },
    // A real host and cell: each case waits on a few dials over loopback.
    RELAY_CASE_TIMEOUT_MS
  )

  it(
    'while its host is offline, its callers wait on one hold: few dials, no spun backoff, the hold kept past a failed director lookup',
    async () => {
      const resolvedAt: number[] = []
      // The director can't be reached: the lookup the 4404 streak asks for fails.
      const resolveRelay = vi.fn(async () => {
        resolvedAt.push(performance.now())
        throw new Error('director unreachable')
      })
      const host = await startHostOverRelay(cleanups, { resolveRelay })
      expect((await host.link.request('status.get', { probe: true }, 15_000)).ok).toBe(true)
      host.cellState.hostOffline = true
      host.cell.cut()
      const dialsBefore = host.cellState.dialedAt.length
      // Streams and probes asking again and again, as a client's many owners do.
      const asking = setInterval(() => {
        host.link.request('status.get', { probe: true }, 1_000).catch(() => {})
      }, 100)
      cleanups.push(() => clearInterval(asking))
      // ast-grep-ignore: test-no-real-time-wait -- counts real dials over a stretch of the hold
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      const dials = host.cellState.dialedAt.slice(dialsBefore)
      // Dials at about 0, 1.5 and 3-4.5 s, never one per caller.
      expect(dials.length).toBeLessThanOrEqual(4)
      // One timer: after the episode's first 4404 the channel redials itself on the hold, so the
      // connection's own backoff isn't stacked on it, nor spun by each held caller.
      expect(host.link.getDiagnostics().reconnectAttempt).toBeLessThanOrEqual(2)
      // The failed lookup kept the 4404's hold: the next dial still waited.
      expect(resolvedAt).toHaveLength(1)
      const nextDial = dials.find((at) => at > resolvedAt[0])
      if (nextDial !== undefined) {
        expect(nextDial - resolvedAt[0]).toBeGreaterThanOrEqual(1_000)
      }

      host.cellState.hostOffline = false
      await vi.waitFor(
        async () =>
          expect((await host.link.request('status.get', { probe: true }, 2_000)).ok).toBe(true),
        // The hold is capped at 15 s.
        { timeout: 20_000 }
      )
    },
    // A real host and cell: each case waits on a few dials over loopback.
    RELAY_CASE_TIMEOUT_MS
  )

  it(
    'an explicit Connect lifts the hold: the host back online is dialed at once',
    async () => {
      vi.stubEnv('ORCA_TEST_REMOTE_RUNTIME_ONE_LINK', '1')
      const parked = parkedRelayDials()
      const host = await startHostOverRelay(cleanups, { mainOpener: true })
      expect((await host.link.request('status.get', { probe: true }, 15_000)).ok).toBe(true)
      host.cellState.hostOffline = true
      host.cell.cut()
      const asking = setInterval(() => {
        host.link.request('status.get', { probe: true }, 1_000).catch(() => {})
      }, 100)
      cleanups.push(() => clearInterval(asking))
      // Four dials, and the client has taken the last one's 4404 and parked the next behind its hold:
      // none is in flight (it would connect once the host is back) and none is still to be answered.
      await vi.waitFor(
        () => {
          expect(host.cellState.dialedAt.length).toBeGreaterThanOrEqual(4)
          expect(parked()).toBeGreaterThan(0)
        },
        { timeout: 15_000 }
      )
      const dials = host.cellState.dialedAt.length
      host.cellState.hostOffline = false
      const connectAt = performance.now()
      clearRelayDialHolds('relay-link-test')
      await vi.waitFor(() => expect(host.cellState.dialedAt.length).toBeGreaterThan(dials), {
        timeout: 5_000
      })
      expect(host.cellState.dialedAt[dials] - connectAt).toBeLessThan(500)
    },
    // A real host and cell: each case waits on a few dials over loopback.
    RELAY_CASE_TIMEOUT_MS
  )
})

/** How many dials wait out a hold now: each dial `afterHold` didn't run at once, until it runs or
 *  is cancelled. */
function parkedRelayDials(): () => number {
  let parked = 0
  const afterHold = RelayRuntimeDialMemory.prototype.afterHold
  const spy = vi.spyOn(RelayRuntimeDialMemory.prototype, 'afterHold').mockImplementation(function (
    this: RelayRuntimeDialMemory,
    dial: () => void
  ) {
    let ran = false
    let waiting = false
    const leave = (): void => {
      if (waiting) {
        waiting = false
        parked -= 1
      }
    }
    const cancel = afterHold.call(this, () => {
      ran = true
      leave()
      dial()
    })
    if (!ran) {
      waiting = true
      parked += 1
    }
    return () => {
      leave()
      cancel()
    }
  })
  cleanups.push(() => spy.mockRestore())
  return () => parked
}
