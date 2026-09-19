import { afterEach, expect, it, vi } from 'vitest'
import { RelayDispatcher, type SinkWriteSettlement } from './dispatcher'
import { RelayGraceLifecycle } from './relay-grace-lifecycle'
import { RelayOwnerReset } from './relay-owner-reset'
import { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'
import type { PtyHandler } from './pty-handler'
import { encodeJsonRpcFrame } from './protocol'
import { RELAY_PREPARED_RESET_RECOVERY_METHOD } from '../shared/relay-owner-reset-contract'

let dispatcher: RelayDispatcher | undefined
afterEach(() => {
  dispatcher?.dispose()
  vi.restoreAllMocks()
})

it.each(['same-transport', 'reconnect', 'new-coordinator'])(
  'replays prepared reset through %s without repeating real lifecycle disposal',
  async (mode) => {
    const writes: {
      message: Record<string, unknown>
      settle: (result: SinkWriteSettlement) => void
    }[] = []
    const write: ConstructorParameters<typeof RelayDispatcher>[0] = (data, settle) => {
      const length = data.readUInt32BE(9)
      writes.push({ message: JSON.parse(data.subarray(13, 13 + length).toString()), settle })
      return true
    }
    const identity = {
      principal: 'owner',
      authenticated: true,
      allowSessionOwner: true,
      authenticationKind: 'endpoint-credential' as const
    }
    dispatcher = new RelayDispatcher(write, { supportsWriteCallback: true }, identity)
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build')
    const dispose = vi.fn(async () => {})
    const owned = vi.fn(async () => {})
    const runtime = vi.fn()
    let transferActive = true
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const lifecycle = new RelayGraceLifecycle({
      dispatcher,
      ptyHandler: {
        setOwnershipTransferGraceGuardEnabled: vi.fn(),
        cancelGraceTimer: vi.fn(),
        get hasLiveOwnershipTransferFence() {
          return transferActive
        },
        dispose
      } as unknown as PtyHandler,
      detached: true,
      emptyDetachedStartupGraceMs: 100,
      idleRelayGraceMs: 100,
      readSocketClientCount: () => 1,
      hasAcceptedSocketClient: () => true,
      ownsSocketPath: () => true,
      disposeOwnedProcesses: owned,
      disposeRuntime: runtime
    })
    const reset = new RelayOwnerReset({ owners: adapter, lifecycle, ownsEndpoint: () => true })
    dispatcher.onRequest('relay.reset', (params, context) => reset.prepare(params, context))
    dispatcher.onRequest(RELAY_PREPARED_RESET_RECOVERY_METHOD, async (params, context) =>
      reset.recoverPrepared(params, context)
    )
    const mutation = vi.fn(async () => {})
    dispatcher.onRequest('fs.writeFile', mutation)
    let seq = 0
    let clientId = dispatcher.activeClientIds()[0]
    const send = (method: string, params: Record<string, unknown>, id?: number) =>
      dispatcher!.feedClient(
        clientId,
        encodeJsonRpcFrame(
          { jsonrpc: '2.0', method, params, ...(id === undefined ? {} : { id }) },
          ++seq,
          0
        )
      )
    send(
      'pty.openClient',
      { protocolVersion: 1, clientInstanceId: 'desktop', requestedRole: 'session-owner' },
      1
    )
    await vi.waitFor(() => expect(writes.some((write) => write.message.id === 1)).toBe(true))
    const grant = writes.find((write) => write.message.id === 1)!
    grant.settle({ ok: true })
    const owner = grant.message.result as Record<string, unknown>
    const params = {
      version: 1,
      runtimeIncarnation: reset.runtimeIncarnation,
      operationId: 'reset-1',
      ownerGeneration: owner.ownerGeneration,
      ownerLease: owner.ownerLease
    }
    send('relay.reset', { ...params, operationId: 'refused-reset' }, 10)
    await vi.waitFor(() => expect(writes.some((write) => write.message.id === 10)).toBe(true))
    const refused = writes.find((write) => write.message.id === 10)!
    expect(refused.message.error).toMatchObject({
      message: 'pty_ownership_transfer_source_shutdown_fenced'
    })
    refused.settle({ ok: true })
    expect(dispose).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
    transferActive = false
    send('relay.reset', params, 2)
    await vi.waitFor(() => expect(writes.some((write) => write.message.id === 2)).toBe(true))
    expect(dispose).toHaveBeenCalledOnce()
    expect(owned).toHaveBeenCalledOnce()
    send('rpc.cancel', { id: 2 })
    writes.find((write) => write.message.id === 2)!.settle({ ok: true })
    expect(exit).not.toHaveBeenCalled()
    if (mode !== 'same-transport') {
      dispatcher.invalidateClient('peer-closed')
      clientId = dispatcher.attachClient(write, { supportsWriteCallback: true }, identity)
      expect(adapter.activeSessionOwner(clientId)).toBeNull()
      send(
        'pty.openClient',
        {
          protocolVersion: 1,
          clientInstanceId: 'desktop',
          requestedRole: 'session-owner'
        },
        22
      )
      await vi.waitFor(() => expect(writes.some((write) => write.message.id === 22)).toBe(true))
      const fencedGrant = writes.find((write) => write.message.id === 22)!
      expect(fencedGrant.message.error).toMatchObject({ message: 'relay_work_admission_closed' })
      fencedGrant.settle({ ok: true })
      expect(adapter.activeSessionOwner(clientId)).toBeNull()
      if (mode === 'new-coordinator') {
        const replacement = new RelayOwnerReset({
          owners: adapter,
          lifecycle,
          ownsEndpoint: () => true
        })
        expect(replacement.runtimeIncarnation).not.toBe(reset.runtimeIncarnation)
        dispatcher.onRequest(RELAY_PREPARED_RESET_RECOVERY_METHOD, async (params, context) =>
          replacement.recoverPrepared(params, context)
        )
        for (const [id, runtimeIncarnation] of [
          [20, reset.runtimeIncarnation],
          [21, replacement.runtimeIncarnation]
        ] as const) {
          send(RELAY_PREPARED_RESET_RECOVERY_METHOD, { ...params, runtimeIncarnation }, id)
          await vi.waitFor(() => expect(writes.some((write) => write.message.id === id)).toBe(true))
          const refusal = writes.find((write) => write.message.id === id)!
          expect(refusal.message.error).toMatchObject({
            message: 'relay_reset_continuation_unauthorized'
          })
          refusal.settle({ ok: true })
          expect(exit).not.toHaveBeenCalled()
        }
        dispatcher.onRequest(RELAY_PREPARED_RESET_RECOVERY_METHOD, async (params, context) =>
          reset.recoverPrepared(params, context)
        )
      }
    }
    send(
      mode === 'same-transport' ? 'relay.reset' : RELAY_PREPARED_RESET_RECOVERY_METHOD,
      params,
      3
    )
    await vi.waitFor(() => expect(writes.some((write) => write.message.id === 3)).toBe(true))
    const retry = writes.find((write) => write.message.id === 3)!
    expect(retry.message.result).toEqual({
      version: 1,
      operationId: params.operationId,
      runtimeIncarnation: reset.runtimeIncarnation,
      prepared: true
    })
    expect(dispose).toHaveBeenCalledOnce()
    expect(owned).toHaveBeenCalledOnce()
    send('fs.writeFile', {}, 4)
    await vi.waitFor(() => expect(writes.some((write) => write.message.id === 4)).toBe(true))
    expect(mutation).not.toHaveBeenCalled()
    expect(runtime).not.toHaveBeenCalled()
    retry.settle({ ok: true })
    expect(runtime).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(0)
  }
)
