import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PTY_STARTUP_INGRESS_VERSION } from '../shared/pty-startup-ingress'
import {
  RelayDispatcher,
  type RelayClientSessionIdentity,
  type SinkWriteSettlement
} from './dispatcher'
import { encodeJsonRpcFrame, MessageType } from './protocol'
import { PtyHandler } from './pty-handler'
import { RelayPtySourcePublication } from './relay-pty-source-publication'
import { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

const { mockPtySpawn } = vi.hoisted(() => ({ mockPtySpawn: vi.fn() }))

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

  beforeEach(async () => {
    vi.useFakeTimers()
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    writes = []
    heldResponseId = null
    heldResponseSettlements = []
    dataCallback = undefined
    pausePty = vi.fn()
    mockPtySpawn.mockReset()
    mockPtySpawn.mockReturnValue({
      pid: process.pid,
      onData: vi.fn((callback: (data: string) => void) => {
        dataCallback = callback
      }),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      clear: vi.fn(),
      pause: pausePty,
      resume: vi.fn()
    })
    dispatcher = new RelayDispatcher(
      (data, settle) => {
        writes.push(Buffer.from(data))
        if (heldResponseId !== null && responseResult(data, heldResponseId)) {
          heldResponseSettlements.push(settle)
          return true
        }
        settle({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    handler = new PtyHandler(dispatcher)
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
      responseResult(replacementWrites.find((buffer) => responseResult(buffer, 4))!, 4)
    ).toMatchObject({
      id: 'pty-1',
      incarnationId: expect.any(String),
      sourceActivation: expect.objectContaining({ deliveryToken: expect.any(String) })
    })
    expect(
      replacementWrites.map(notification).find((frame) => frame?.method === 'pty.data')?.params
    ).toMatchObject({
      id: 'pty-1',
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

    handler.handleSourcePublicationCapacity('pty-1')
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
    dispatcher.onClientDetached((clientId) => detached.push(clientId))
    const saturatedId = dispatcher.attachClient(() => false, {
      supportsWriteCallback: true,
      writableLength: () => 16 * 1024,
      writableHighWaterMark: () => 4 * 1024 * 1024
    })
    const healthyId = dispatcher.attachClient(
      (data, settle) => {
        healthyWrites.push(Buffer.from(data))
        settle({ ok: true })
        return true
      },
      { supportsWriteCallback: true }
    )
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
})
