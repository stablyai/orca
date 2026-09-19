import { connect } from 'node:net'
import { once } from 'node:events'
import { expect, it, vi } from 'vitest'
import { cleanup, echoServer, fixture } from './ssh-relay-network-test-fixture'
import { SshRelayPortForwardProvider } from './ssh-relay-port-forward-provider'
import { SshPortForwardRetirementCohort } from './ssh-port-forward-retirement-cohort'
import type { SshConnection } from './ssh-connection'

const request = {
  version: 1 as const,
  operationId: 'forward-reset',
  runtimeIncarnation: 'runtime',
  ownerGeneration: 1,
  ownerLease: 'lease'
}

it('reconciles a drained TCP forward only after exact host reset proof and local closure', async () => {
  const f = fixture()
  const port = await echoServer()
  const tunnel = await f.create()
  const connection = {} as SshConnection
  const provider = new SshRelayPortForwardProvider(async () => ({
    tunnel,
    connection,
    assertCurrent: f.assertCurrent,
    assertAdmission: f.assertCurrent,
    release: (signal) => tunnel.fenceForDrain().drain(signal)
  }))
  const forward = await provider.start(connection, {
    id: 'forward',
    connectionId: 'target',
    localHost: '127.0.0.1',
    localPort: 0,
    remoteHost: '127.0.0.1',
    remotePort: port
  })
  cleanup.push(() => forward.close().catch(() => {}))
  const cohort = new SshPortForwardRetirementCohort()
  cohort.register(forward)
  const opened = vi.spyOn(tunnel, 'open')
  const client = connect(forward.entry.localPort, '127.0.0.1')
  client.on('error', () => {})
  cleanup.push(() => {
    client.destroy()
  })
  await once(client, 'connect')
  await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce())
  const chunks: Buffer[] = []
  client.on('data', (bytes: Buffer) => chunks.push(bytes))
  const closed = once(client, 'close')
  const payload = Buffer.alloc(96 * 1024, 0x75)
  client.end(payload)
  const drain = cohort.fenceForDrain()
  const signal = new AbortController().signal
  await Promise.all([closed, drain.drain(signal)])
  expect(Buffer.concat(chunks).equals(payload)).toBe(true)
  f.mux.fenceForRelayReset()
  await f.mux.waitForRelayResetDrain(signal)
  const host = f.registry.fenceForDrain()
  await host.drain(signal)
  host.seal()
  f.dispatcher.onRequest('relay.reset', async () => ({
    version: 1,
    operationId: request.operationId,
    runtimeIncarnation: request.runtimeIncarnation,
    prepared: true
  }))
  await f.mux.request('relay.reset', request, {
    beforeResolve: () => {
      tunnel.confirmResetRetirement(request)
      f.mux.dispose()
    }
  })
  f.assertCurrent.mockImplementation(() => {
    throw new Error('owner retired')
  })
  drain.assertDrained()
  expect(forward.resetRetirementConfirmed).toBeUndefined()
  expect(() => cohort.reconcileResetRetirement(request)).toThrow()
  await forward.close()
  expect(forward.retirementConfirmed).toBe(false)
  expect(forward.resetRetirementConfirmed).toEqual(request)
  expect(Object.isFrozen(forward.resetRetirementConfirmed)).toBe(true)
  await drain.drain(signal)
  drain.assertDrained()
  expect(() => cohort.reconcileResetRetirement({ ...request, operationId: 'other' })).toThrow(
    'reset_receipt_mismatch'
  )
  expect(cohort.isEmpty).toBe(false)
  cohort.pruneRetired()
  expect(cohort.isEmpty).toBe(false)
  cohort.reconcileResetRetirement(request)
  drain.assertDrained()
  expect(cohort.isEmpty).toBe(true)
  cohort.assertReconciled()
  expect(f.sentMethods).not.toContain('relay.networkTunnel.close')
})
