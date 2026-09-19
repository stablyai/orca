import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayDispatcher, type RelayClientSessionIdentity } from './dispatcher'
import { encodeJsonRpcFrame } from './protocol'
import { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

const endpointIdentity: RelayClientSessionIdentity = {
  principal: 'endpoint-principal',
  authenticated: true,
  allowSessionOwner: true,
  authenticationKind: 'endpoint-credential'
}

function frame(id: number, method: string, overrides: Record<string, unknown> = {}): Buffer {
  return encodeJsonRpcFrame(
    {
      jsonrpc: '2.0',
      id,
      method,
      params: {
        protocolVersion: 1,
        clientInstanceId: 'stable-client',
        requestedRole: 'session-owner',
        ...overrides
      }
    },
    id,
    0
  )
}

function response(buffer: Buffer) {
  return JSON.parse(buffer.subarray(13, 13 + buffer.readUInt32BE(9)).toString('utf8'))
}

async function flushRequests(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('pty.resumeClient through RelayDispatcher', () => {
  let dispatcher: RelayDispatcher | undefined
  afterEach(() => dispatcher?.dispose())

  function fixture() {
    const writes: Buffer[] = []
    dispatcher = new RelayDispatcher(
      (data, settled) => {
        writes.push(Buffer.from(data))
        settled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a')
    return { dispatcher, adapter, writes }
  }

  it('refuses absent historical ownership without minting a fresh owner or reserving the connection', async () => {
    const { dispatcher, adapter, writes } = fixture()
    const resume = { ownerGeneration: 1, ownerLease: 'forgotten-lease' }
    dispatcher.feed(frame(1, 'pty.resumeClient', { resume }))
    await flushRequests()
    expect(response(writes[0]).error.message).toContain('pty_consumer_resume_owner_missing')
    expect(adapter.activeSessionOwner(1)).toBeNull()
    expect(() => adapter.assertOwnerPublicationSettled()).not.toThrow()
    dispatcher.feed(frame(2, 'pty.openClient', { resume }))
    await flushRequests()
    expect(response(writes[1]).result).toMatchObject({
      role: 'session-owner',
      clientGeneration: 1,
      ownerGeneration: 1,
      resumed: false
    })
    expect(adapter.activeSessionOwner(1)).not.toBeNull()
  })

  it.each([true, false])(
    'settles exact-owner resume authority only on response publication (success=%s)',
    async (ok) => {
      const { dispatcher, adapter, writes } = fixture()
      dispatcher.feed(frame(1, 'pty.openClient'))
      await flushRequests()
      const grant = response(writes[0]).result
      const incumbent = adapter.activeSessionOwner(1)
      expect(incumbent).not.toBeNull()
      const resumedWrites: Buffer[] = []
      const settlements: ((result: { ok: true } | { ok: false; error: Error }) => void)[] = []
      const successor = dispatcher.attachClient(
        (data, settled) => {
          resumedWrites.push(Buffer.from(data))
          settlements.push(settled)
          return true
        },
        { supportsWriteCallback: true },
        endpointIdentity
      )
      const release = vi.spyOn(dispatcher, 'releaseDisplacedClient')
      dispatcher.feedClient(
        successor,
        frame(2, 'pty.resumeClient', {
          resume: { ownerGeneration: grant.ownerGeneration, ownerLease: grant.ownerLease }
        })
      )
      await flushRequests()
      expect(response(resumedWrites[0]).result).toMatchObject({
        role: 'session-owner',
        resumed: true,
        ownerGeneration: 2,
        ownerLease: grant.ownerLease
      })
      expect(adapter.activeSessionOwner(1)).toEqual(incumbent)
      expect(adapter.activeSessionOwner(successor)).toBeNull()
      expect(release).not.toHaveBeenCalled()
      expect(() => adapter.assertOwnerPublicationSettled()).toThrow(
        'pty_consumer_owner_publication_pending'
      )
      settlements[0](ok ? { ok: true } : { ok: false, error: new Error('response failed') })
      expect(() => adapter.assertOwnerPublicationSettled()).not.toThrow()
      if (ok) {
        expect(adapter.activeSessionOwner(1)).toBeNull()
        expect(adapter.activeSessionOwner(successor)).not.toBeNull()
        expect(release).toHaveBeenCalledTimes(1)
      } else {
        expect(adapter.activeSessionOwner(1)).toEqual(incumbent)
        expect(adapter.activeSessionOwner(successor)).toBeNull()
        expect(release).not.toHaveBeenCalled()
      }
      release.mockRestore()
    }
  )
})
