import { Duplex } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { RelayDispatcher } from '../../relay/dispatcher'
import { SshPtyConsumerSessionAdapter } from '../../relay/ssh-pty-consumer-session-adapter'
import {
  encodeHandshakeFrame,
  encodeJsonRpcFrame,
  FrameDecoder,
  parseHandshakeMessage
} from '../../relay/protocol'
import type { SshPtyConsumerRecovery } from '../../shared/ssh-types'
import { resumeOrcadSavedSshSource } from './orcad-saved-source-resume'

afterEach(() => vi.unstubAllEnvs())

it('authenticates a saved source and durably resumes its actual host owner over the mux', async () => {
  vi.stubEnv('ORCA_ENABLE_PTY_OWNERSHIP_TRANSFER_MUTATION', '1')
  const identity = {
    principal: 'relay-endpoint:saved-build',
    authenticated: true,
    allowSessionOwner: true,
    authenticationKind: 'endpoint-credential' as const
  }
  const initial: Buffer[] = []
  const dispatcher = new RelayDispatcher(
    (data, settled) => {
      initial.push(Buffer.from(data))
      settled({ ok: true })
      return true
    },
    { supportsWriteCallback: true },
    identity
  )
  const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'saved-build')
  let stream: Duplex | undefined
  try {
    dispatcher.feed(
      encodeJsonRpcFrame(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'pty.openClient',
          params: {
            protocolVersion: 1,
            clientInstanceId: 'saved-client',
            requestedRole: 'session-owner'
          }
        },
        1,
        0
      )
    )
    await new Promise((resolve) => setImmediate(resolve))
    const grant = JSON.parse(
      initial[0].subarray(13, 13 + initial[0].readUInt32BE(9)).toString()
    ).result
    let recovery: SshPtyConsumerRecovery = {
      targetId: 'source',
      clientInstanceId: 'saved-client',
      serverBuildId: 'saved-build',
      clientGeneration: grant.clientGeneration,
      ownerGeneration: grant.ownerGeneration,
      ownerLease: grant.ownerLease
    }
    let handshake = true
    const credential = 'a'.repeat(43)
    const methods: string[] = []
    const decoder = new FrameDecoder(
      (frame) => {
        const message = JSON.parse(frame.payload.toString())
        if (message.method) {
          methods.push(message.method)
        }
      },
      () => {
        throw new Error('wire decode failed')
      }
    )
    const successor = dispatcher.attachClient(
      (data, settled) => {
        stream!.push(Buffer.from(data))
        settled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      identity
    )
    stream = new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        callback()
        if (handshake) {
          handshake = false
          const hello = new FrameDecoder(
            (frame) => {
              expect(parseHandshakeMessage(frame.payload)).toEqual({
                type: 'orca-relay-handshake',
                version: 'saved-build',
                endpointCredential: credential
              })
            },
            () => {
              throw new Error('handshake decode failed')
            }
          )
          hello.feed(chunk)
          queueMicrotask(() =>
            stream!.push(
              encodeHandshakeFrame({
                type: 'orca-relay-handshake-ok',
                version: 'saved-build'
              })
            )
          )
        } else {
          decoder.feed(chunk)
          dispatcher.feedClient(successor, chunk)
        }
      }
    })
    const client = {}
    const connection = {
      getClient: () => client,
      getTarget: () => ({ id: 'source' }),
      getState: () => ({ status: 'connected' }),
      getTransportGeneration: () => 7,
      usesSystemSshTransport: () => false,
      forwardStreamLocal: vi.fn((_client, path, callback) => {
        expect(path).toBe('/saved/relay.sock')
        callback(undefined, stream)
      })
    }
    const durable = Promise.withResolvers<void>()
    const upsert = vi.fn(async (record) => {
      recovery = structuredClone(record)
      await durable.promise
    })
    const pending = resumeOrcadSavedSshSource({
      connection: connection as never,
      targetId: 'source',
      ownerLease: grant.ownerLease,
      source: {
        endpoint: '/saved/relay.sock',
        incumbentVersion: 'saved-build',
        endpointCredential: credential
      },
      signal: new AbortController().signal,
      assertAuthority: () => {},
      store: {
        getSshPtyConsumerRecovery: () => structuredClone(recovery),
        upsertSshPtyConsumerRecovery: upsert
      }
    })
    const returned = vi.fn()
    void pending.then(returned)
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledOnce())
    expect(returned).not.toHaveBeenCalled()
    expect(methods).toEqual(['pty.resumeClient'])
    expect(recovery.ownerGeneration).toBe(grant.ownerGeneration + 1)
    durable.resolve()
    const resumed = await pending
    expect(resumed.session.owner.ownerLease).toBe(grant.ownerLease)
    expect(adapter.activeSessionOwner(successor)).toMatchObject({
      ownerGeneration: recovery.ownerGeneration
    })
    resumed.assertCurrent()
    resumed.dispose()
    expect(stream.destroyed).toBe(true)
  } finally {
    stream?.destroy()
    dispatcher.dispose()
  }
})
