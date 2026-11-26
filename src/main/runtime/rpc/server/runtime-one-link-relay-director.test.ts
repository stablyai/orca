// A desktop paired over Relay only, when the cell it knows stops answering for its credential
// (4409): it asks the Relay director where the host is now, as the phone does, and redials once.
// A director that no longer knows the credential (401) ends the link instead of a redial loop.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayDirectorHttpError } from '../../../../shared/remote-runtime/relay/client/relay-director-resolve'
import type { MobileRelayEndpoint } from '../../../../shared/remote-runtime/relay/mobile-relay-credential-contract'
import { startHostOverRelay } from '../testing/relay-runtime-host.test-fixtures'

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
    'while its host is offline, its many callers wait out one backoff instead of each dialing',
    async () => {
      const host = await startHostOverRelay(cleanups)
      expect((await host.link.request('status.get', { probe: true }, 15_000)).ok).toBe(true)
      host.cellState.hostOffline = true
      host.cell.cut()
      const dialsBefore = host.cellState.dialedHosts.length
      // Streams and probes asking again and again, as a client's many owners do.
      const asking = setInterval(() => {
        host.link.request('status.get', { probe: true }, 1_000).catch(() => {})
      }, 100)
      cleanups.push(() => clearInterval(asking))
      // ast-grep-ignore: test-no-real-time-wait -- counts real dials over a stretch of the backoff
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      // Dials at about 0, 1.5 and 4.5 s (1.5 s doubling), never one per caller.
      expect(host.cellState.dialedHosts.length - dialsBefore).toBeLessThanOrEqual(4)

      host.cellState.hostOffline = false
      await vi.waitFor(
        async () =>
          expect((await host.link.request('status.get', { probe: true }, 2_000)).ok).toBe(true),
        { timeout: 15_000 }
      )
    },
    // A real host and cell: each case waits on a few dials over loopback.
    RELAY_CASE_TIMEOUT_MS
  )
})
