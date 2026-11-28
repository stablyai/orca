import { createServer, type Server } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useVouchingSocketOwnerHelper } from '../../browser/network/tunnels/darwin-socket-owner-helper.test-fixture'
import type { PairedRuntimeConnection } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import {
  closeAllPairedPortForwards,
  configurePairedPortForwards,
  ensurePairedPortForward,
  listPairedPortForwards,
  updatePairedPortForward
} from './paired-port-forwards'
import {
  endPairedForwardSession,
  endPairedForwardSessionOnAbort
} from './paired-port-forward-session-end'

const connection: PairedRuntimeConnection = {
  endpoint: 'ws://127.0.0.1:9',
  hostPublicKeyB64: 'server-key',
  credential: { kind: 'token', deviceToken: 'device-token' }
}

async function freePort(): Promise<number> {
  const server: Server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!address || typeof address === 'string') {
    throw new Error('no port')
  }
  return address.port
}

function configure(saved: Map<string, unknown>): void {
  configurePairedPortForwards({
    resolveConnection: async () => connection,
    onChanged: () => {},
    saved: {
      all: () => Object.fromEntries(saved),
      set: (id, record) => (record ? saved.set(id, record) : saved.delete(id))
    }
  })
}

const ids = (): string[] => listPairedPortForwards('env-1').map((entry) => entry.id)

// Session ids are per attach in production; ended ones stay ended, so each test uses its own.
describe('session paired port forwards', () => {
  // On macOS every forward checks its connections' owner through the bundled helper.
  let restoreOwnerHelper = async (): Promise<void> => {}
  beforeAll(async () => {
    restoreOwnerHelper = (await useVouchingSocketOwnerHelper()).restore
  })
  afterAll(() => restoreOwnerHelper())

  afterEach(async () => {
    await closeAllPairedPortForwards()
  })

  it('are owned by one session, unsaved, off the server port number, and close with it', async () => {
    const saved = new Map<string, unknown>()
    configure(saved)
    // Free here, so only the session rule keeps the forward off the number local simulators start on.
    const remotePort = await freePort()

    const a = await ensurePairedPortForward({ environmentId: 'env-1', remotePort, session: 's1' })
    const person = await ensurePairedPortForward({ environmentId: 'env-1', remotePort })
    expect(a.entry.localPort).not.toBe(remotePort)
    expect(person.entry.id).not.toBe(a.entry.id)

    await endPairedForwardSession('s1')
    expect(ids()).toEqual([person.entry.id])
    expect(saved.get('env-1')).toMatchObject({ forwards: [{ remotePort }] })
  })

  it('opens nothing for a session that ends while its ensure is still queued', async () => {
    configure(new Map())
    const remotePort = await freePort()

    const pending = ensurePairedPortForward({ environmentId: 'env-1', remotePort, session: 's2' })
    await endPairedForwardSession('s2')

    await expect(pending).rejects.toThrow()
    expect(ids()).toEqual([])
  })

  it('keeps a forward a person adopted before its session ended', async () => {
    const saved = new Map<string, unknown>()
    configure(saved)
    const remotePort = await freePort()
    const { entry } = await ensurePairedPortForward({
      environmentId: 'env-1',
      remotePort,
      session: 's3'
    })

    // The person's edit queues first; the session ends while it is still resolving the server.
    await Promise.all([
      updatePairedPortForward({ ...entry, environmentId: 'env-1' }),
      endPairedForwardSession('s3')
    ])

    expect(ids()).toEqual([entry.id])
    expect(saved.get('env-1')).toMatchObject({ forwards: [{ localPort: entry.localPort }] })
  })

  it('closes when the window that opened it reloads', async () => {
    configure(new Map())
    const remotePort = await freePort()
    const window = new AbortController()
    let disposed = false
    endPairedForwardSessionOnAbort('s4', window.signal, () => {
      disposed = true
    })
    await ensurePairedPortForward({ environmentId: 'env-1', remotePort, session: 's4' })

    window.abort()
    await expect.poll(ids).toEqual([])
    expect(disposed).toBe(true)
  })
})
