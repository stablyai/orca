import { expect, it, vi } from 'vitest'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { encodeFrame, MessageType, HEADER_LENGTH } from './relay-protocol'
import {
  executeSshRelayResetTransaction,
  executeSshRelayResetWithRetirementRecords
} from './ssh-relay-reset-transaction'
import {
  parseSshRelayResetRetirementSelection,
  parseSshRelayResetPreparationReceipt,
  sshRelayResetRecordDigest
} from './ssh-relay-reset-retirement-record'
import type { SshRelayResetIntent } from './ssh-relay-reset-intent'
import { parseRelayResetPreparationBinding } from '../../shared/relay-reset-preparation-contract'
import {
  RELAY_OWNER_RESET_CAPABILITY,
  RELAY_DURABLE_RESET_PREPARATION_CAPABILITY,
  RELAY_PREPARED_RESET_RECOVERY_METHOD
} from '../../shared/relay-owner-reset-contract'

function fixture() {
  const intent: SshRelayResetIntent = {
    version: 1,
    targetId: 'host-1',
    targetGeneration: 1,
    targetRoutingDigest: 'a'.repeat(64),
    clientInstanceId: 'desktop-1',
    serverBuildId: 'build-1',
    endpoint: {
      relayDir: '/relay',
      runtimePath: '/relay/bun-runtime',
      runtimeKind: 'bun',
      sockPath: '/relay/relay.sock',
      credentialFile: '/relay/credential',
      relayPlatform: 'linux-x64'
    },
    request: {
      version: 1,
      operationId: 'reset-1',
      runtimeIncarnation: 'daemon-1',
      ownerGeneration: 1,
      ownerLease: 'secret-lease'
    }
  }
  const status = {
    capabilities: [RELAY_OWNER_RESET_CAPABILITY],
    ownerReset: { version: 1, runtimeIncarnation: 'daemon-1' }
  }
  const ack = { version: 1, operationId: 'reset-1', runtimeIncarnation: 'daemon-1', prepared: true }
  const events: string[] = []
  const request = vi.fn(
    async (
      method: string,
      _params?: Record<string, unknown>,
      options?: Parameters<SshChannelMultiplexer['request']>[2]
    ) => {
      events.push(method)
      const result = method === 'relay.status' ? status : ack
      options?.beforeResolve?.(result)
      return result
    }
  )
  const persist = vi.fn(async (value: SshRelayResetIntent) => {
    events.push('persist')
    return value
  })
  const assertAuthority = vi.fn(() => {})
  const options = {
    intent,
    mux: { request, assertRelayResetAcknowledgmentDrained: vi.fn() },
    persist,
    assertAuthority,
    mode: 'active-owner' as const
  }
  return { options, intent, status, ack, request, persist, assertAuthority, events }
}

it.each(['matching', 'changed', 'missing-capability'])(
  'revalidates durable metadata before any reset effects: %s',
  async (mode) => {
    const f = fixture()
    const preparation = parseRelayResetPreparationBinding({
      version: 1,
      journalDirectory: '/journal',
      principal: 'owner',
      authenticationKind: 'endpoint-credential',
      sockPath: f.intent.endpoint.sockPath,
      serverBuildId: f.intent.serverBuildId
    })
    const options = { ...f.options, intent: { ...f.intent, preparation } }
    Object.assign(f.status.ownerReset, {
      preparation: mode === 'changed' ? { ...preparation, principal: 'other' } : preparation
    })
    if (mode !== 'missing-capability') {
      f.status.capabilities.push(RELAY_DURABLE_RESET_PREPARATION_CAPABILITY)
    }
    if (mode === 'matching') {
      await expect(executeSshRelayResetTransaction(options)).resolves.toEqual(f.ack)
    } else {
      await expect(executeSshRelayResetTransaction(options)).rejects.toThrow(
        'preparation_binding_changed'
      )
      expect(f.persist).not.toHaveBeenCalled()
      expect(f.events).toEqual(['relay.status'])
    }
  }
)

it.each(['valid', 'invalid-ack', 'stale-owner', 'undrained'])(
  'captures preparation synchronously before real mux disposal: %s',
  async (scenario) => {
    const f = fixture()
    let receive!: (bytes: Buffer) => void
    let sequence = 1
    let ownerCurrent = true
    const captured = vi.fn()
    const mux = new SshChannelMultiplexer({
      supportsWriteSettlement: true,
      onData: (callback) => {
        receive = callback
      },
      onClose: () => {},
      write: (bytes, settle) => {
        const request = JSON.parse(bytes.subarray(HEADER_LENGTH).toString())
        settle?.({ ok: true })
        const reset = request.method !== 'relay.status'
        queueMicrotask(() => {
          if (reset && scenario === 'stale-owner') {
            ownerCurrent = false
          }
          const result = reset
            ? { ...f.ack, operationId: scenario === 'invalid-ack' ? 'wrong' : f.ack.operationId }
            : f.status
          receive(
            encodeFrame(
              MessageType.Regular,
              sequence++,
              0,
              Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
            )
          )
          if (reset) {
            mux.dispose('connection_lost')
          }
        })
        return true
      }
    })
    try {
      mux.fenceForRelayReset()
      await mux.waitForRelayResetDrain(new AbortController().signal)
      const transaction = executeSshRelayResetTransaction({
        ...f.options,
        mux,
        assertAuthority: () => {
          if (!ownerCurrent || mux.isDisposed()) {
            throw new Error('stale authority')
          }
        },
        onPreparedAcknowledgment: (acknowledgment, intent) => {
          if (scenario === 'undrained') {
            throw new Error('local work not drained')
          }
          expect(mux.isDisposed()).toBe(false)
          expect(Object.isFrozen(acknowledgment)).toBe(true)
          expect(Object.isFrozen(intent.request)).toBe(true)
          captured(acknowledgment, intent)
          return undefined
        }
      })
      if (scenario === 'valid') {
        await expect(transaction).resolves.toEqual(f.ack)
        expect(captured).toHaveBeenCalledExactlyOnceWith(f.ack, f.intent)
      } else {
        await expect(transaction).rejects.toThrow()
        expect(captured).not.toHaveBeenCalled()
      }
      expect(mux.isDisposed()).toBe(true)
    } finally {
      mux.dispose()
    }
  }
)

it('does not capture after awaiting a transport that omits the synchronous reply hook', async () => {
  const f = fixture()
  f.request.mockImplementation(async (method) => (method === 'relay.status' ? f.status : f.ack))
  const capture = vi.fn(() => undefined)
  await expect(
    executeSshRelayResetTransaction({ ...f.options, onPreparedAcknowledgment: capture })
  ).rejects.toThrow('capture_missing')
  expect(capture).not.toHaveBeenCalled()
})

it('requires a synchronous transport-drain gate before capturing preparation', async () => {
  const f = fixture()
  const capture = vi.fn(() => undefined)
  await expect(
    executeSshRelayResetTransaction({
      ...f.options,
      mux: { request: f.request },
      onPreparedAcknowledgment: capture
    })
  ).rejects.toThrow('drain_gate_missing')
  expect(capture).not.toHaveBeenCalled()
})

it('negotiates and durably records intent before requesting initial reset', async () => {
  const f = fixture()
  await expect(executeSshRelayResetTransaction(f.options)).resolves.toEqual(f.ack)
  expect(f.events).toEqual(['relay.status', 'persist', 'relay.reset'])
  expect(f.assertAuthority).toHaveBeenCalledTimes(3)
})

it.each(['missing-capability', 'missing-version', 'new-incarnation'])(
  'refuses %s without persistence or reset',
  async (failure) => {
    const f = fixture()
    if (failure === 'missing-capability') {
      f.status.capabilities = []
    }
    if (failure === 'missing-version') {
      f.status.ownerReset.version = 0
    }
    if (failure === 'new-incarnation') {
      f.status.ownerReset.runtimeIncarnation = 'daemon-2'
    }
    await expect(executeSshRelayResetTransaction(f.options)).rejects.toThrow()
    expect(f.persist).not.toHaveBeenCalled()
    expect(f.events).toEqual(['relay.status'])
  }
)

it.each(['throw', 'wrong-record'])(
  'refuses uncertain persistence (%s) before sending reset',
  async (failure) => {
    const f = fixture()
    f.persist.mockImplementation(async (value) => {
      if (failure === 'throw') {
        throw new Error('durability failed')
      }
      return { ...value, request: { ...value.request, operationId: 'different' } }
    })
    await expect(executeSshRelayResetTransaction(f.options)).rejects.toThrow()
    expect(f.request).toHaveBeenCalledTimes(1)
  }
)

it.each([1, 2, 3])('refuses authority loss at boundary %i', async (boundary) => {
  const f = fixture()
  let count = 0
  f.assertAuthority.mockImplementation(() => {
    if (++count === boundary) {
      throw new Error('stale authority')
    }
  })
  await expect(executeSshRelayResetTransaction(f.options)).rejects.toThrow('stale authority')
  expect(f.request.mock.calls.some(([method]) => method === 'relay.reset')).toBe(false)
})

it.each(['operationId', 'runtimeIncarnation', 'prepared', 'version'])(
  'rejects mismatched acknowledgment %s',
  async (field) => {
    const f = fixture()
    Object.assign(f.ack, { [field]: null })
    await expect(executeSshRelayResetTransaction(f.options)).rejects.toThrow(
      'relay_reset_acknowledgment_invalid'
    )
    expect(f.persist).toHaveBeenCalledOnce()
  }
)

it('retains the exact intent after timeout and uses only prepared continuation on reconnect', async () => {
  const f = fixture()
  f.request.mockImplementationOnce(async () => f.status).mockRejectedValueOnce(new Error('timeout'))
  await expect(executeSshRelayResetTransaction(f.options)).rejects.toThrow('timeout')
  expect(f.persist.mock.calls[0][0]).toEqual(f.intent)
  f.events.length = 0
  await executeSshRelayResetTransaction({ ...f.options, mode: 'prepared-recovery' })
  expect(f.events).toEqual(['relay.status', 'persist', RELAY_PREPARED_RESET_RECOVERY_METHOD])
  expect(f.persist.mock.calls[1][0]).toEqual(f.intent)
})

it('waits for persistence and snapshots caller-owned intent before awaiting', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<SshRelayResetIntent>()
  f.persist.mockReturnValue(pending.promise)
  const result = executeSshRelayResetTransaction(f.options)
  await vi.waitFor(() => expect(f.persist).toHaveBeenCalledOnce())
  expect(f.request).toHaveBeenCalledTimes(1)
  Object.assign(f.intent.request, { operationId: 'mutated' })
  pending.resolve(f.persist.mock.calls[0][0])
  await expect(result).resolves.toMatchObject({ operationId: 'reset-1' })
})

it.each(['success', 'selection-failure', 'receipt-failure', 'capture-failure'])(
  'journals selection before reset and receipt before returning: %s',
  async (failure) => {
    const f = fixture()
    const selection = parseSshRelayResetRetirementSelection(
      {
        version: 1,
        intentSha256: sshRelayResetRecordDigest(f.intent),
        clientIncarnation: 'desktop',
        retiredAt: 100,
        leases: [],
        routes: []
      },
      f.intent
    )
    const store = {
      persist: f.persist,
      persistSelection: vi.fn(async () => {
        f.events.push('selection')
        if (failure === 'selection-failure') {
          throw new Error('selection failed')
        }
        return selection
      }),
      persistReceipt: vi.fn(async (_intent: unknown, value: unknown) => {
        f.events.push('receipt')
        if (failure === 'receipt-failure') {
          throw new Error('receipt failed')
        }
        return parseSshRelayResetPreparationReceipt(value, f.intent, selection)
      })
    }
    const result = executeSshRelayResetWithRetirementRecords({
      ...f.options,
      selection,
      store,
      onPreparedAcknowledgment: () => {
        f.events.push('capture')
        if (failure === 'capture-failure') {
          throw new Error('local drain proof unavailable')
        }
        return undefined
      }
    })
    await (failure === 'success'
      ? expect(result).resolves.toMatchObject({ acknowledgment: f.ack })
      : expect(result).rejects.toThrow())
    expect(f.events).toEqual(
      failure === 'selection-failure'
        ? ['relay.status', 'persist', 'selection']
        : failure === 'capture-failure'
          ? ['relay.status', 'persist', 'selection', 'relay.reset', 'capture']
          : ['relay.status', 'persist', 'selection', 'relay.reset', 'capture', 'receipt']
    )
  }
)
