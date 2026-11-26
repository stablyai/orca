// A desktop paired over Relay only, through the real Relay path with a stand-in cell: what happens
// to its credentials when a link drops mid-install, the cell refuses them, or the host revokes it.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../../../shared/remote-runtime/pairing/pairing'
import { addEnvironmentFromPairingCode } from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import { handleManagedSharedControlRefusal } from '../../../ipc/runtime-environments/pairing/runtime-environment-managed-pairing-refusal'
import { getRuntimeEnvironmentStatusSnapshot } from '../../../ipc/runtime-environments/connections/runtime-environment-request-connections'
import { cutRelayLinksTurnedOff } from '../../../ipc/runtime-environments/connections/runtime-environment-relay-link'
import { sendRemoteRuntimeConnectionRequestAbortable } from '../../../ipc/runtime-environments/requests/runtime-environment-abortable-requests'
import { sendRemoteRuntimeRequestOnSocket } from '../../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { clearRemoteRuntimeOneLink } from '../../../../shared/remote-runtime/control/remote-runtime-one-link'
import { statusProbeRidesControl } from '../../../ipc/runtime-environments/status/runtime-environment-status-owner'
import {
  RELAY_TEST_INVITE as INVITE,
  startHostOverRelay
} from '../testing/relay-runtime-host.test-fixtures'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

const RELAY_CASE_TIMEOUT_MS = 30_000

describe('a desktop paired over Relay only', () => {
  it(
    'probes status over its link from the first call, and never dials the Relay endpoint itself',
    async () => {
      const { connection } = await startHostOverRelay(cleanups)
      expect(statusProbeRidesControl(connection, false, false)).toBe(true)
      clearRemoteRuntimeOneLink('relay-link-test')
      await expect(
        sendRemoteRuntimeRequestOnSocket(connection, 'status.get', undefined, 5_000)
      ).rejects.toMatchObject({
        code: 'remote_runtime_unavailable',
        message: expect.stringContaining('only over Relay')
      })
    },
    // A real host and cell: each case waits on a few dials over loopback.
    RELAY_CASE_TIMEOUT_MS
  )

  it(
    'redials on the resume credential whose install committed just before the link dropped',
    async () => {
      let cut = (): void => {}
      const host = await startHostOverRelay(cleanups, {
        afterInstallCommitted: () => cut()
      })
      let cuts = 0
      cut = () => {
        if (cuts++ === 0) {
          host.cell.cut()
        }
      }
      // The call waiting on the first link fails with it; the next rides the redial.
      await expect(host.link.request('status.get', { probe: true }, 15_000)).rejects.toThrow()
      expect((await host.link.request('status.get', { probe: true }, 15_000)).ok).toBe(true)
      // The spent invite once, then the committed credential: never the invite again.
      expect(host.cell.credentials).toHaveLength(2)
      expect(host.cell.credentials[0]).toBe(INVITE)
      expect(host.cell.credentials[1]).toBe(host.entry()?.resume?.token)
      expect(host.entry()?.pendingResume).toBeUndefined()
    },
    // A real host and cell: each case waits on a few dials over loopback.
    RELAY_CASE_TIMEOUT_MS
  )

  it(
    'stops redialing once Relay refuses its resume credential, and never dials the spent invite',
    async () => {
      const host = await startHostOverRelay(cleanups)
      expect((await host.link.request('status.get', { probe: true }, 15_000)).ok).toBe(true)
      expect(host.entry()?.refusedInvite).toBe(INVITE)
      host.cellState.resumeRevoked = true
      host.cell.cut()
      await vi.waitFor(() => expect(host.cell.credentials).toHaveLength(2), { timeout: 15_000 })
      await expect(host.link.request('status.get', { probe: true }, 5_000)).rejects.toMatchObject({
        code: 'relay_credential_unavailable'
      })
      expect(host.cell.credentials).toEqual([INVITE, expect.not.stringMatching(INVITE)])
      // Nothing left to present: no standing retry, until a call or a new pairing asks again.
      expect(host.link.getDiagnostics().state).toBe('closed')
    },
    // A real host and cell: each case waits on a few dials over loopback.
    RELAY_CASE_TIMEOUT_MS
  )

  it(
    'when its host revokes it: Relay forgets its credential, and the desktop stops and says so',
    async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-refused-'))
      cleanups.push(() => rmSync(userDataPath, { recursive: true, force: true }))
      let environmentId = ''
      const outcomes: unknown[] = []
      // Main's own handler for a host refusing this device, on a stored Relay-paired environment.
      const host = await startHostOverRelay(cleanups, {
        control: {
          onAuthenticationRejected: () =>
            handleManagedSharedControlRefusal(userDataPath, environmentId).then((outcome) => {
              outcomes.push(outcome)
              return outcome
            })
        }
      })
      const { connection } = host
      if (connection.credential.kind !== 'token') {
        throw new Error('expected a token pairing')
      }
      environmentId = (
        await addEnvironmentFromPairingCode(userDataPath, {
          name: 'Desk over Relay',
          pairingCode: encodePairingOffer({
            v: 2,
            endpoint: connection.endpoint,
            publicKeyB64: connection.hostPublicKeyB64,
            deviceToken: connection.credential.deviceToken,
            pairedDeviceId: host.deviceId
          })
        })
      ).id
      expect((await host.link.request('status.get', { probe: true }, 15_000)).ok).toBe(true)
      expect(host.server.revokeRuntimeAccess(host.deviceId)).toBe(true)
      // Relay's own record of this computer goes too, as a phone's does.
      expect(host.revokesQueued).toHaveLength(1)
      // The cell still admits the resume credential here; the host itself refuses the device.
      host.cell.cut()
      await vi.waitFor(() => expect(outcomes).toEqual(['stop']), { timeout: 15_000 })
      // As paseo and superset do: no standing retry after the host refused this device.
      expect(host.link.getDiagnostics().state).toBe('closed')
      expect(getRuntimeEnvironmentStatusSnapshot(environmentId)?.verification).toBe('blocked')
    },
    // A real host and cell: each case waits on a few dials over loopback.
    RELAY_CASE_TIMEOUT_MS
  )

  it(
    'when Orca Cloud turns one link off: the live link is cut, and its streams and calls hear why',
    async () => {
      vi.stubEnv('ORCA_TEST_REMOTE_RUNTIME_ONE_LINK', '1')
      const host = await startHostOverRelay(cleanups, { mainOpener: true })
      expect((await host.link.request('status.get', { probe: true }, 15_000)).ok).toBe(true)
      const errors: string[] = []
      await host.link.subscribe('test.ticks', null, 10_000, {
        onResponse: () => {},
        onError: (error) => void errors.push(error.code)
      })
      vi.stubEnv('ORCA_TEST_REMOTE_RUNTIME_ONE_LINK', '')
      cutRelayLinksTurnedOff()
      await expect(host.link.request('status.get', { probe: true }, 5_000)).rejects.toMatchObject({
        code: 'relay_one_link_off'
      })
      // The link stays the host's one link: a call through it is refused, not dialed elsewhere.
      await expect(
        sendRemoteRuntimeConnectionRequestAbortable(
          'relay-link-test',
          host.connection,
          'status.get',
          undefined,
          5_000
        )
      ).rejects.toMatchObject({ code: 'relay_one_link_off' })
      expect(host.link.getDiagnostics().state).toBe('closed')
      expect(errors).toContain('relay_one_link_off')
    },
    // A real host and cell: each case waits on a few dials over loopback.
    RELAY_CASE_TIMEOUT_MS
  )

  it(
    'refuses a request socket to the Relay endpoint, for a call made before its link exists',
    async () => {
      const { connection } = await startHostOverRelay(cleanups)
      clearRemoteRuntimeOneLink('relay-link-test')
      await expect(
        sendRemoteRuntimeConnectionRequestAbortable(
          'relay-unlinked',
          connection,
          'terminal.send',
          { terminal: 't', text: 'x' },
          5_000
        )
      ).rejects.toMatchObject({
        code: 'remote_runtime_unavailable',
        message: expect.stringContaining('only over Relay')
      })
    },
    // A real host and cell: each case waits on a few dials over loopback.
    RELAY_CASE_TIMEOUT_MS
  )
})
