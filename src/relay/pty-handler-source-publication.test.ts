import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PTY_STARTUP_INGRESS_VERSION } from '../shared/pty-startup-ingress'
import {
  RelayDispatcher,
  type RelayClientSessionIdentity,
  type SinkWriteSettlement
} from './dispatcher'
import { encodeJsonRpcFrame, MessageType } from './protocol'
import { PtyHandler } from './pty-handler'
import { TEST_PTY_ID_MINT_EPOCH, testPtyId } from './pty-handler-test-harness'
import { RelayPtySourcePublication } from './relay-pty-source-publication'
import { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

const { mockPtySpawn } = vi.hoisted(() => ({ mockPtySpawn: vi.fn() }))

const PTY_1 = testPtyId(1)

vi.mock('node-pty', () => ({ spawn: mockPtySpawn }))

const endpointIdentity: RelayClientSessionIdentity = {
  principal: 'endpoint-principal',
  authenticated: true,
  allowSessionOwner: true,
  authenticationKind: 'endpoint-credential'
}

type Notification = { method: string; params: Record<string, unknown> }

function requestFrame(id: number, method: string, params: Record<string, unknown>): Buffer {
  return encodeJsonRpcFrame({ jsonrpc: '2.0', id, method, params }, id, 0)
}

function notification(buffer: Buffer): Notification | null {
  if (buffer[0] !== MessageType.Regular) {
    return null
  }
  const length = buffer.readUInt32BE(9)
  const message = JSON.parse(buffer.subarray(13, 13 + length).toString('utf8'))
  return typeof message.method === 'string' && message.id === undefined ? message : null
}

function responseResult(buffer: Buffer, id: number): Record<string, unknown> | null {
  if (buffer[0] !== MessageType.Regular) {
    return null
  }
  const length = buffer.readUInt32BE(9)
  const message = JSON.parse(buffer.subarray(13, 13 + length).toString('utf8'))
  return message.id === id ? (message.result ?? null) : null
}

describe('PtyHandler negotiated source publication', () => {
  let dispatcher: RelayDispatcher
  let handler: PtyHandler
  let publication: RelayPtySourcePublication
  let dataCallback: ((data: string) => void) | undefined
  let originalPlatform: PropertyDescriptor | undefined
  let writes: Buffer[]
  let heldResponseId: number | null
  let heldResponseSettlements: ((result: SinkWriteSettlement) => void)[]
  let adapter: SshPtyConsumerSessionAdapter
  let pausePty: ReturnType<typeof vi.fn>
  let exitCallback: ((event: { exitCode: number }) => void) | undefined
  let destroyPty: ReturnType<typeof vi.fn>
  let holdDataSettlements: boolean
  let heldDataSettlements: ((result: SinkWriteSettlement) => void)[]
  let holdExitSettlements: boolean
  let heldExitSettlements: ((result: SinkWriteSettlement) => void)[]
  let highWaterMark: number | undefined

  beforeEach(async () => {
    vi.useFakeTimers()
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    writes = []
    heldResponseId = null
    heldResponseSettlements = []
    dataCallback = undefined
    exitCallback = undefined
    holdDataSettlements = false
    heldDataSettlements = []
    holdExitSettlements = false
    heldExitSettlements = []
    highWaterMark = undefined
    pausePty = vi.fn()
    destroyPty = vi.fn()
    mockPtySpawn.mockReset()
    mockPtySpawn.mockReturnValue({
      pid: process.pid,
      onData: vi.fn((callback: (data: string) => void) => {
        dataCallback = callback
      }),
      onExit: vi.fn((callback: (event: { exitCode: number }) => void) => {
        exitCallback = callback
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      clear: vi.fn(),
      pause: pausePty,
      resume: vi.fn(),
      destroy: destroyPty
    })
    dispatcher = new RelayDispatcher(
      (data, settle) => {
        writes.push(Buffer.from(data))
        if (heldResponseId !== null && responseResult(data, heldResponseId)) {
          heldResponseSettlements.push(settle)
          return true
        }
        const frame = notification(data)
        if (holdDataSettlements && frame?.method === 'pty.data') {
          heldDataSettlements.push(settle)
          return true
        }
        if (frame?.method === 'pty.exit') {
          if (holdExitSettlements) {
            heldExitSettlements.push(settle)
            return true
          }
          // Why: real sockets never settle inside write(); a synchronous settle would re-enter
          // the legacy capacity path before the pending exit is retired.
          queueMicrotask(() => settle({ ok: true }))
          return true
        }
        settle({ ok: true })
        return true
      },
      {
        supportsWriteCallback: true,
        writableHighWaterMark: () => highWaterMark ?? 0
      },
      endpointIdentity
    )
    handler = new PtyHandler(dispatcher, undefined, TEST_PTY_ID_MINT_EPOCH)
    adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a', undefined, (id) =>
      publication.onCreditAvailable(id)
    )
    publication = new RelayPtySourcePublication(dispatcher, adapter, (id) =>
      handler.handleSourcePublicationCapacity(id)
    )
    handler.setSourcePublication(publication)
    dispatcher.feed(
      requestFrame(1, 'pty.openClient', {
        protocolVersion: 1,
        clientInstanceId: 'client-1',
        requestedRole: 'session-owner',
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 1024 } }
      })
    )
    await vi.advanceTimersByTimeAsync(0)
  })

  afterEach(async () => {
    await handler.dispose({ waitForPhysicalExit: false }).catch(() => {})
    dispatcher.dispose()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    vi.useRealTimers()
  })

  async function spawn(params: Record<string, unknown>): Promise<void> {
    dispatcher.feed(requestFrame(2, 'pty.spawn', params))
    await vi.advanceTimersByTimeAsync(0)
    expect(dataCallback).toBeTypeOf('function')
  }

  function sourceDataFrames(): Notification[] {
    return writes
      .map(notification)
      .filter((frame): frame is Notification => frame?.method === 'pty.data')
  }

  function exitFrames(): Notification[] {
    return writes
      .map(notification)
      .filter((frame): frame is Notification => frame?.method === 'pty.exit')
  }

  async function cancelSourceDelivery(spawnResult: Record<string, unknown>): Promise<void> {
    const activation = spawnResult.sourceActivation as Record<string, unknown>
    dispatcher.feed(
      requestFrame(9, 'pty.cancelDelivery', {
        id: spawnResult.id,
        clientGeneration: activation.clientGeneration,
        ownerGeneration: activation.ownerGeneration,
        deliveryToken: activation.deliveryToken
      })
    )
    await vi.advanceTimersByTimeAsync(0)
  }

  function stubPublication(overrides: Partial<Record<string, unknown>>): RelayPtySourcePublication {
    return {
      accepts: () => true,
      exitPublicationSettled: () => false,
      sealAndPublishExit: () => false,
      publish: () => false,
      onCreditAvailable: () => {},
      receivingActivation: () => undefined,
      waitForPendingSend: async () => true,
      activate: () => false,
      getDebugSnapshot: () => ({}),
      dispose: () => {},
      ...overrides
    } as unknown as RelayPtySourcePublication
  }

  it('publishes a single legacy exit after the owner cancels its delivery', async () => {
    await spawn({})
    const spawnResult = writes.map((buffer) => responseResult(buffer, 2)).find(Boolean)!
    dataCallback!('prompt')
    await vi.advanceTimersByTimeAsync(8)
    await cancelSourceDelivery(spawnResult)
    expect(publication.accepts(String(spawnResult.id))).toBe(false)

    expect(() => exitCallback!({ exitCode: 0 })).not.toThrow()

    expect(exitFrames()).toHaveLength(1)
    expect(exitFrames()[0].params).toMatchObject({ id: spawnResult.id, code: 0 })
    expect(destroyPty).toHaveBeenCalledOnce()

    handler.handleSourcePublicationCapacity(String(spawnResult.id))
    await vi.advanceTimersByTimeAsync(8)
    expect(exitFrames()).toHaveLength(1)
  })

  async function attachSubscriber(
    holdDataSettlement?: (settle: (result: SinkWriteSettlement) => void) => boolean
  ): Promise<Buffer[]> {
    const subscriberWrites: Buffer[] = []
    const clientId = dispatcher.attachClient(
      (data, settle) => {
        subscriberWrites.push(Buffer.from(data))
        const frame = notification(data)
        if (frame?.method === 'pty.data' && holdDataSettlement?.(settle)) {
          return true
        }
        if (frame?.method === 'pty.exit') {
          // Why: real sockets never settle inside write(); see the primary sink above.
          queueMicrotask(() => settle({ ok: true }))
          return true
        }
        settle({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    dispatcher.feedClient(
      clientId,
      requestFrame(20, 'pty.openClient', {
        protocolVersion: 1,
        clientInstanceId: 'legacy-subscriber',
        requestedRole: 'subscriber'
      })
    )
    await vi.advanceTimersByTimeAsync(0)
    return subscriberWrites
  }

  function subscriberExitFrames(subscriberWrites: Buffer[]): Notification[] {
    return subscriberWrites
      .map(notification)
      .filter((frame): frame is Notification => frame?.method === 'pty.exit')
  }

  it('never re-delivers the exit to subscribers when a cancel retires the record', async () => {
    await spawn({})
    const spawnResult = writes.map((buffer) => responseResult(buffer, 2)).find(Boolean)!
    const subscriberWrites = await attachSubscriber()
    dataCallback!('prompt')
    await vi.advanceTimersByTimeAsync(8)

    // Why: the owner's producer lane is saturated when the PTY exits, so only the legacy
    // projection lands; the record then still holds the undelivered owner exit.
    highWaterMark = 64
    expect(() => exitCallback!({ exitCode: 0 })).not.toThrow()
    await vi.advanceTimersByTimeAsync(8)
    expect(subscriberExitFrames(subscriberWrites)).toHaveLength(1)

    highWaterMark = undefined
    await cancelSourceDelivery(spawnResult)
    await vi.advanceTimersByTimeAsync(8)

    expect(subscriberExitFrames(subscriberWrites)).toHaveLength(1)
  })

  it('drains the pending exit once the retired record published it', async () => {
    await spawn({})
    const spawnResult = writes.map((buffer) => responseResult(buffer, 2)).find(Boolean)!
    dataCallback!('prompt')
    await vi.advanceTimersByTimeAsync(8)
    holdExitSettlements = true

    exitCallback!({ exitCode: 0 })
    await vi.advanceTimersByTimeAsync(0)
    expect(heldExitSettlements).toHaveLength(1)
    await cancelSourceDelivery(spawnResult)
    // Why: the in-flight frame failing on a canceled delivery is the only path that reaches
    // the retiring branch with an unsettled exit publication.
    heldExitSettlements[0]({ ok: false, error: new Error('socket write failed') })
    await vi.advanceTimersByTimeAsync(8)
    expect(exitFrames()).toHaveLength(2)

    handler.handleSourcePublicationCapacity(String(spawnResult.id))
    await vi.advanceTimersByTimeAsync(8)

    expect(exitFrames()).toHaveLength(2)
  })

  it('drains buffered legacy output before the exit when capacity returns', async () => {
    await spawn({})
    const spawnResult = writes.map((buffer) => responseResult(buffer, 2)).find(Boolean)!
    await cancelSourceDelivery(spawnResult)
    const subscriberWrites = await attachSubscriber((settle) => {
      if (!holdDataSettlements) {
        return false
      }
      heldDataSettlements.push(settle)
      return true
    })
    holdDataSettlements = true

    dataCallback!('first')
    await vi.advanceTimersByTimeAsync(8)
    expect(heldDataSettlements).toHaveLength(1)
    // Why: shrinking the frame capacity makes the next chunk unpublishable, so it stays queued.
    highWaterMark = 64
    dataCallback!('second')
    await vi.advanceTimersByTimeAsync(8)

    expect(() => exitCallback!({ exitCode: 3 })).not.toThrow()
    expect(exitFrames()).toHaveLength(0)

    highWaterMark = undefined
    holdDataSettlements = false
    heldDataSettlements[0]({ ok: true })
    await vi.advanceTimersByTimeAsync(8)

    const frames = subscriberWrites
      .map(notification)
      .filter(
        (frame): frame is Notification =>
          frame?.method === 'pty.data' || frame?.method === 'pty.exit'
      )
    expect(frames.map((frame) => frame.method)).toEqual(['pty.data', 'pty.data', 'pty.exit'])
    expect(frames.map((frame) => frame.params.data)).toEqual(['first', 'second', undefined])
    expect(frames.at(-1)!.params).toMatchObject({ id: spawnResult.id, code: 3 })
  })

  it('contains a source publication fault and still delivers the legacy exit', async () => {
    await spawn({})
    const spawnResult = writes.map((buffer) => responseResult(buffer, 2)).find(Boolean)!
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      handler.setSourcePublication(
        stubPublication({
          sealAndPublishExit: () => {
            throw new Error('ledger delivery vanished')
          }
        })
      )

      expect(() => exitCallback!({ exitCode: 7 })).not.toThrow()

      expect(exitFrames()).toHaveLength(1)
      expect(exitFrames()[0].params).toMatchObject({ id: spawnResult.id, code: 7 })
      expect(String(stderr.mock.calls.at(-1)?.[0])).toContain(
        '[pty-handler] pty source exit publication failed'
      )
    } finally {
      stderr.mockRestore()
    }
  })

  it('retires the delivery after the owner exit publication throws', async () => {
    await spawn({})
    const spawnResult = writes.map((buffer) => responseResult(buffer, 2)).find(Boolean)!
    const id = String(spawnResult.id)
    const subscriberWrites = await attachSubscriber()
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const publishOwnerExit = vi
      .spyOn(dispatcher, 'tryNotifyPtyExitToClient')
      .mockImplementationOnce(() => {
        throw new Error('owner write failed')
      })
    try {
      expect(() => exitCallback!({ exitCode: 8 })).not.toThrow()
      await vi.advanceTimersByTimeAsync(0)

      expect(exitFrames()).toHaveLength(1)
      expect(subscriberExitFrames(subscriberWrites)).toHaveLength(1)
      expect(publication.accepts(id)).toBe(false)
      expect(adapter.getDebugSnapshot().deliveryTokens).toBe(0)

      handler.handleSourcePublicationCapacity(id)
      await vi.advanceTimersByTimeAsync(0)
      expect(exitFrames()).toHaveLength(1)
      expect(subscriberExitFrames(subscriberWrites)).toHaveLength(1)
    } finally {
      publishOwnerExit.mockRestore()
      stderr.mockRestore()
    }
  })

  it('retires the delivery when committed owner exit settlement fails', async () => {
    await spawn({})
    const spawnResult = writes.map((buffer) => responseResult(buffer, 2)).find(Boolean)!
    const id = String(spawnResult.id)
    const subscriberWrites = await attachSubscriber()
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const settleOwnerExit = vi.spyOn(adapter, 'settleExitPublication').mockImplementation(() => {
      throw new Error('exit settlement failed')
    })
    try {
      exitCallback!({ exitCode: 9 })
      await vi.advanceTimersByTimeAsync(0)

      expect(exitFrames()).toHaveLength(1)
      expect(subscriberExitFrames(subscriberWrites)).toHaveLength(1)
      expect(publication.accepts(id)).toBe(false)
      expect(adapter.getDebugSnapshot().deliveryTokens).toBe(0)

      handler.handleSourcePublicationCapacity(id)
      await vi.advanceTimersByTimeAsync(0)
      expect(exitFrames()).toHaveLength(1)
      expect(subscriberExitFrames(subscriberWrites)).toHaveLength(1)
    } finally {
      settleOwnerExit.mockRestore()
      stderr.mockRestore()
    }
  })

  it('lets a retired record re-target its own exit instead of broadcasting a duplicate', async () => {
    await spawn({})
    const spawnResult = writes.map((buffer) => responseResult(buffer, 2)).find(Boolean)!
    const subscriberWrites = await attachSubscriber()
    const publishExitAfterRetire = vi.fn(() => true)
    handler.setSourcePublication(stubPublication({ accepts: () => false, publishExitAfterRetire }))

    expect(() => exitCallback!({ exitCode: 4 })).not.toThrow()

    expect(publishExitAfterRetire).toHaveBeenCalledWith(
      expect.objectContaining({ id: spawnResult.id, code: 4 })
    )
    expect(exitFrames()).toHaveLength(0)
    expect(subscriberExitFrames(subscriberWrites)).toHaveLength(0)

    handler.handleSourcePublicationCapacity(String(spawnResult.id))
    await vi.advanceTimersByTimeAsync(8)
    expect(publishExitAfterRetire).toHaveBeenCalledOnce()
  })

  it('broadcasts the legacy exit when the retired record never projected one', async () => {
    await spawn({})
    const spawnResult = writes.map((buffer) => responseResult(buffer, 2)).find(Boolean)!
    handler.setSourcePublication(
      stubPublication({ accepts: () => false, publishExitAfterRetire: () => null })
    )

    exitCallback!({ exitCode: 5 })

    expect(exitFrames()).toHaveLength(1)
    expect(exitFrames()[0].params).toMatchObject({ id: spawnResult.id, code: 5 })
  })

  it('contains a retired-record publication fault and falls back to the legacy exit', async () => {
    await spawn({})
    const spawnResult = writes.map((buffer) => responseResult(buffer, 2)).find(Boolean)!
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      handler.setSourcePublication(
        stubPublication({
          accepts: () => false,
          publishExitAfterRetire: () => {
            throw new Error('retired owner lookup failed')
          }
        })
      )

      expect(() => exitCallback!({ exitCode: 6 })).not.toThrow()

      expect(exitFrames()).toHaveLength(1)
      expect(exitFrames()[0].params).toMatchObject({ id: spawnResult.id, code: 6 })
      expect(String(stderr.mock.calls.at(-1)?.[0])).toContain(
        '[pty-handler] retired pty exit publication failed'
      )
    } finally {
      stderr.mockRestore()
    }
  })

  it('completes the exit from the settled state without re-sealing the delivery', async () => {
    await spawn({})
    const spawnResult = writes.map((buffer) => responseResult(buffer, 2)).find(Boolean)!
    const sealAndPublishExit = vi.fn(() => true)
    handler.setSourcePublication(
      stubPublication({ exitPublicationSettled: () => true, sealAndPublishExit })
    )

    exitCallback!({ exitCode: 0 })
    handler.handleSourcePublicationCapacity(String(spawnResult.id))

    expect(sealAndPublishExit).not.toHaveBeenCalled()
    expect(exitFrames()).toHaveLength(0)
  })

  it('fences the first source frame behind immutable spawn and attach activation metadata', async () => {
    heldResponseId = 2
    await spawn({})
    const spawnResult = writes.map((buffer) => responseResult(buffer, 2)).find(Boolean)!
    const sourceActivation = spawnResult.sourceActivation as Record<string, unknown>

    expect(sourceActivation).toMatchObject({
      status: 'pending',
      clientGeneration: 1,
      ownerGeneration: 1,
      ptyIncarnation: spawnResult.incarnationId,
      deliveryToken: expect.any(String),
      checkpointSourceEndSu: 0,
      recoveryEndSu: 0
    })
    dataCallback!('prompt')
    await vi.advanceTimersByTimeAsync(8)
    expect(sourceDataFrames()).toHaveLength(0)

    heldResponseSettlements[0]({ ok: true })
    const firstSource = sourceDataFrames()[0]
    expect(firstSource.params).toMatchObject({
      id: spawnResult.id,
      data: 'prompt',
      clientGeneration: sourceActivation.clientGeneration,
      ownerGeneration: sourceActivation.ownerGeneration,
      ptyIncarnation: sourceActivation.ptyIncarnation,
      deliveryToken: sourceActivation.deliveryToken,
      sourceEndSu: 6
    })

    dispatcher.feed(requestFrame(3, 'pty.attach', { id: spawnResult.id }))
    await vi.advanceTimersByTimeAsync(0)
    const attachResult = writes.map((buffer) => responseResult(buffer, 3)).find(Boolean)!
    expect(attachResult.sourceActivation).toEqual(sourceActivation)
  })

  it('settles a consumed POSIX startup query before publishing its prompt', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    await spawn({
      startupIngressVersion: PTY_STARTUP_INGRESS_VERSION,
      startupIngress: {
        colors: { foreground: '#2e3434', background: '#ffffff' },
        deadlineMs: 5_000
      }
    })
    const query = '\x1b]10;?\x07'

    dataCallback!(query)
    dataCallback!('prompt')
    await vi.advanceTimersByTimeAsync(9)

    expect(sourceDataFrames().map((frame) => frame.params)).toEqual([
      expect.objectContaining({
        data: '',
        rawLength: query.length,
        transformed: true,
        sourceLengthSu: query.length,
        sourceEndSu: query.length
      }),
      expect.objectContaining({
        data: 'prompt',
        rawLength: 6,
        sourceLengthSu: 6,
        sourceEndSu: query.length + 6
      })
    ])
    expect(publication.getDebugSnapshot()).toMatchObject({ sendCommitted: 2 })
  })

  it('settles a suppressed ConPTY query before publishing its prompt', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    await spawn({ shellOverride: 'powershell.exe' })
    const query = '\x1b]10;?\x07'

    dataCallback!(query)
    dataCallback!('PS> ')
    await vi.advanceTimersByTimeAsync(9)

    expect(sourceDataFrames().map((frame) => frame.params)).toEqual([
      expect.objectContaining({
        data: '',
        rawLength: query.length,
        transformed: true,
        sourceLengthSu: query.length,
        sourceEndSu: query.length
      }),
      expect.objectContaining({
        data: 'PS> ',
        rawLength: 4,
        sourceLengthSu: 4,
        sourceEndSu: query.length + 4
      })
    ])
    expect(publication.getDebugSnapshot()).toMatchObject({ sendCommitted: 2 })
  })

  it('activates a fresh source consumer when an operation response is lost and retried', async () => {
    const operationId = 'a'.repeat(43)
    const grant = writes.map((buffer) => responseResult(buffer, 1)).find(Boolean)!
    heldResponseId = 2
    dispatcher.feed(
      requestFrame(2, 'pty.spawn', {
        agentSessionCreateOperationId: operationId
      })
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(heldResponseSettlements).toHaveLength(1)
    expect(
      writes.map((buffer) => responseResult(buffer, 2)).find(Boolean)?.sourceActivation
    ).toEqual(expect.objectContaining({ deliveryToken: expect.any(String) }))

    dispatcher.invalidateClient()
    expect(adapter.getDebugSnapshot()).toMatchObject({ deliveryTokens: 0 })

    const replacementWrites: Buffer[] = []
    const replacementClientId = dispatcher.attachClient(
      (data, settle) => {
        replacementWrites.push(Buffer.from(data))
        settle({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    dispatcher.feedClient(
      replacementClientId,
      requestFrame(3, 'pty.openClient', {
        protocolVersion: 1,
        clientInstanceId: 'client-1',
        requestedRole: 'session-owner',
        resume: {
          ownerGeneration: grant.ownerGeneration,
          ownerLease: grant.ownerLease
        },
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 1024 } }
      })
    )
    await vi.advanceTimersByTimeAsync(0)
    dispatcher.feedClient(
      replacementClientId,
      requestFrame(4, 'pty.spawn', {
        agentSessionCreateOperationId: operationId
      })
    )
    await vi.advanceTimersByTimeAsync(0)

    dataCallback!('prompt')
    await vi.advanceTimersByTimeAsync(8)

    expect(mockPtySpawn).toHaveBeenCalledOnce()
    expect(
      responseResult(
        replacementWrites.find((buffer) => responseResult(buffer, 4))!,
        4
      )
    ).toMatchObject({
      id: PTY_1,
      incarnationId: expect.any(String),
      sourceActivation: expect.objectContaining({ deliveryToken: expect.any(String) })
    })
    expect(
      replacementWrites.map(notification).find((frame) => frame?.method === 'pty.data')?.params
    ).toMatchObject({
      id: PTY_1,
      data: 'prompt',
      sourceLengthSu: 6,
      sourceEndSu: 6
    })
    expect(adapter.getDebugSnapshot()).toMatchObject({ deliveryTokens: 1 })
  })

  it('republishes the identical memoized span after a failed projection', async () => {
    await spawn({})
    const appendSpy = vi.spyOn(adapter, 'appendSource')
    const projectSpy = vi
      .spyOn(dispatcher, 'projectPtyDataToMatchingClients')
      .mockReturnValueOnce(false)
    // Why: a larger capacity result on the retry must not move the memoized span boundary.
    const maxCharsSpy = vi.spyOn(dispatcher, 'maxLegacyPtyDataChars')
    maxCharsSpy.mockReturnValueOnce(4).mockReturnValue(8)

    dataCallback!('abcdefgh')
    await vi.advanceTimersByTimeAsync(8)
    expect(projectSpy).toHaveBeenCalledTimes(1)

    handler.handleSourcePublicationCapacity(PTY_1)
    await vi.advanceTimersByTimeAsync(8)

    // Retried projection carries the byte-identical span params.
    expect(projectSpy.mock.calls[1][1]).toEqual(projectSpy.mock.calls[0][1])
    const spans = appendSpy.mock.calls.map(([, input]) => input)
    expect(spans.filter((span) => span.data === 'abcd')).toHaveLength(1)
    expect(spans.map((span) => span.data).join('')).toBe('abcdefgh')
    expect(spans.map((span) => [span.displayStart, span.displayEnd])).toEqual([
      [0, 4],
      [4, 8]
    ])
  })

  it('keeps the native PTY and V1 owner live when one subscriber saturates', async () => {
    await spawn({})
    const detached: number[] = []
    const healthyWrites: Buffer[] = []
    let saturateSubscriber = false
    dispatcher.onClientDetached((clientId) => detached.push(clientId))
    const saturatedId = dispatcher.attachClient(
      (_data, settle) => {
        if (saturateSubscriber) {
          return false
        }
        settle({ ok: true })
        return true
      },
      {
        supportsWriteCallback: true,
        writableLength: () => 16 * 1024,
        writableHighWaterMark: () => 4 * 1024 * 1024
      },
      endpointIdentity
    )
    const healthyId = dispatcher.attachClient(
      (data, settle) => {
        healthyWrites.push(Buffer.from(data))
        settle({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    dispatcher.feedClient(
      saturatedId,
      requestFrame(20, 'pty.openClient', {
        protocolVersion: 1,
        clientInstanceId: 'saturated-subscriber',
        requestedRole: 'subscriber'
      })
    )
    dispatcher.feedClient(
      healthyId,
      requestFrame(21, 'pty.openClient', {
        protocolVersion: 1,
        clientInstanceId: 'healthy-subscriber',
        requestedRole: 'subscriber'
      })
    )
    await vi.advanceTimersByTimeAsync(0)
    saturateSubscriber = true
    const payload = 's'.repeat(16 * 1024)
    let admitted = 0
    while (
      dispatcher.tryNotifyPtyDataToClient(saturatedId, { id: 'saturated', data: payload }, () => {})
    ) {
      admitted++
    }

    dataCallback!(payload)
    await vi.advanceTimersByTimeAsync(8)

    expect(admitted).toBeGreaterThan(100)
    expect(admitted).toBeLessThan(140)
    expect(detached).toEqual([saturatedId])
    expect(detached).not.toContain(healthyId)
    expect(
      healthyWrites.map(notification).filter((frame) => frame?.method === 'pty.data')
    ).toHaveLength(1)
    expect(sourceDataFrames()).toHaveLength(1)
    expect(publication.getDebugSnapshot()).toMatchObject({ sendCommitted: 1 })
    expect(pausePty).not.toHaveBeenCalled()
  })

  // The reported defect, in the shape measured against the live relay: the client attaches twice
  // for the same PTY. The first registers a source delivery under the primary client's id; the
  // second finds `current.clientId === context.clientId`, answers 'existing', and returns NO
  // replay. Live, every pane on reconnect logged path=existing-delivery and painted nothing.
  //
  // A reattach always lands in a NEW terminal — a reconnect bumps tab.generation, which is the
  // pane's React key, so TerminalPane remounts and the old xterm is disposed with its buffer.
  describe('a second attach for the same client', () => {
    async function attach(id: number, params: Record<string, unknown>) {
      writes = []
      dispatcher.feed(requestFrame(id, 'pty.attach', { id: PTY_1, ...params }))
      await vi.advanceTimersByTimeAsync(0)
      return writes.map((buffer) => responseResult(buffer, id)).find(Boolean)
    }

    beforeEach(async () => {
      await spawn({})
      dataCallback!('scrollback-that-must-survive')
      await vi.advanceTimersByTimeAsync(10)
      await attach(10, { suppressReplayNotification: true })
    })

    it('replays the scrollback when the client says it needs it', async () => {
      const second = await attach(11, {
        suppressReplayNotification: true,
        requireReplay: true
      })

      expect(second, 'second attach returned no response').toBeTruthy()
      expect(second!.replay).toContain('scrollback-that-must-survive')
    })

    // The early return is right for a duplicate attach from a client that IS still receiving the
    // stream; only a client that has thrown its terminal away should ask. Pinned so the fix stays
    // opt-in and cannot start double-rendering for callers that never asked.
    it('still sends nothing when the client does not ask', async () => {
      const second = await attach(12, { suppressReplayNotification: true })

      expect(second, 'second attach returned no response').toBeTruthy()
      expect(second!.replay).toBeUndefined()
    })
  })
})
