import { expect, it, vi } from 'vitest'
import { subscribeSshPtyNotifications } from './ssh-pty-notification-routing'

it('routes malformed and unadmitted source frames only to rejection diagnostics', async () => {
  const mux = {
    onNotification: vi.fn(),
    request: vi.fn(async (_method: string, params: Record<string, unknown>) => {
      if (params.deliveryToken !== 'token-1') {
        throw new Error('Unknown or stale PTY source delivery cancellation')
      }
      return { canceled: true, sentEndSu: 0, creditedEndSu: 0 }
    })
  }
  const dataListeners = new Set()
  const rejectedDataListeners = new Set()
  const subscription = subscribeSshPtyNotifications({
    mux: mux as never,
    toAppPtyId: (id) => `ssh:conn@@${id}`,
    dataListeners: dataListeners as never,
    rejectedDataListeners: rejectedDataListeners as never,
    replayListeners: new Set() as never,
    exitListeners: new Set() as never,
    livePtyIds: new Set(),
    recordExit: vi.fn(),
    providerGeneration: 7,
    resolvePtyIncarnation: (id) => `incarnation:${id}`,
    peekPtyIncarnation: () => undefined
  })
  const handler = mux.onNotification.mock.calls[0]?.[0] as (
    method: string,
    params: Record<string, unknown>
  ) => void
  const onData = vi.fn()
  const onRejectedData = vi.fn()
  dataListeners.add(onData)
  rejectedDataListeners.add(onRejectedData)
  subscription
    .installReceivingActivation('pty-1', {
      status: 'pending',
      clientGeneration: 2,
      ownerGeneration: 3,
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-1',
      checkpointSourceEndSu: 0,
      recoveryEndSu: 4
    })
    .commit()

  handler('pty.data', {
    id: 'pty-1',
    data: 'bad',
    deliveryToken: 'token-1',
    clientGeneration: 2,
    ownerGeneration: 3,
    ptyIncarnation: 'incarnation-1',
    sourceEndSu: 4,
    sourceLengthSu: 4
  })
  handler('pty.data', {
    id: 'pty-2',
    data: 'old',
    deliveryToken: 'token-old',
    clientGeneration: 1,
    ownerGeneration: 1,
    ptyIncarnation: 'incarnation-1',
    sourceEndSu: 3,
    sourceLengthSu: 3
  })

  await vi.waitFor(() => expect(onRejectedData).toHaveBeenCalledTimes(2))

  expect(onData).not.toHaveBeenCalled()
  expect(onRejectedData).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ sourceMalformed: true })
  )
  expect(onRejectedData).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      sourceRejected: true,
      source: expect.objectContaining({
        deliveryToken: 'token-old',
        clientGeneration: 1,
        ownerGeneration: 1
      })
    })
  )
})

it('never resolves an incarnation for a rejected frame', async () => {
  const mux = {
    onNotification: vi.fn(),
    request: vi.fn(async () => ({ canceled: true, sentEndSu: 0, creditedEndSu: 0 }))
  }
  const rejectedDataListeners = new Set()
  const resolvePtyIncarnation = vi.fn((id: string) => `incarnation:${id}`)
  subscribeSshPtyNotifications({
    mux: mux as never,
    toAppPtyId: (id) => `ssh:conn@@${id}`,
    dataListeners: new Set() as never,
    rejectedDataListeners: rejectedDataListeners as never,
    replayListeners: new Set() as never,
    exitListeners: new Set() as never,
    livePtyIds: new Set(),
    recordExit: vi.fn(),
    providerGeneration: 7,
    resolvePtyIncarnation,
    peekPtyIncarnation: () => undefined
  })
  const handler = mux.onNotification.mock.calls[0]?.[0] as (
    method: string,
    params: Record<string, unknown>
  ) => void
  const onRejectedData = vi.fn()
  rejectedDataListeners.add(onRejectedData)

  // Why this matters: resolvePtyIncarnation caches what it mints and rememberPtyIncarnation is
  // first-write-wins, so a synthetic id minted here would fence the PTY's real incarnation off for
  // the rest of the generation.
  handler('pty.data', { id: 'pty-1', data: 'bad', deliveryToken: 'token-1', sourceEndSu: 4 })

  await vi.waitFor(() => expect(onRejectedData).toHaveBeenCalledOnce())

  expect(onRejectedData).toHaveBeenCalledOnce()
  expect(onRejectedData).toHaveBeenCalledWith(expect.objectContaining({ sourceMalformed: true }))
  expect(resolvePtyIncarnation).not.toHaveBeenCalled()
})

it('coalesces repeated exact rejections into one fresh-activation recovery', async () => {
  const mux = {
    onNotification: vi.fn(),
    request: vi.fn(async () => ({ canceled: true, sentEndSu: 3, creditedEndSu: 0 }))
  }
  const rejectedDataListeners = new Set()
  const subscription = subscribeSshPtyNotifications({
    mux: mux as never,
    toAppPtyId: (id) => `ssh:conn@@${id}`,
    dataListeners: new Set() as never,
    rejectedDataListeners: rejectedDataListeners as never,
    replayListeners: new Set() as never,
    exitListeners: new Set() as never,
    livePtyIds: new Set(),
    recordExit: vi.fn(),
    providerGeneration: 7,
    resolvePtyIncarnation: (id) => `incarnation:${id}`,
    peekPtyIncarnation: () => 'incarnation-1'
  })
  subscription
    .installReceivingActivation('pty-1', {
      status: 'pending',
      clientGeneration: 2,
      ownerGeneration: 3,
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-1',
      checkpointSourceEndSu: 0,
      recoveryEndSu: 0
    })
    .commit()
  const handler = mux.onNotification.mock.calls[0]?.[0] as (
    method: string,
    params: Record<string, unknown>
  ) => void
  const onRejectedData = vi.fn()
  rejectedDataListeners.add(onRejectedData)
  const rejected = {
    id: 'pty-1',
    data: 'gap',
    deliveryToken: 'token-1',
    clientGeneration: 2,
    ownerGeneration: 3,
    ptyIncarnation: 'incarnation-1',
    sourceEndSu: 6,
    sourceLengthSu: 3
  }

  handler('pty.data', rejected)
  handler('pty.data', rejected)

  await vi.waitFor(() => expect(onRejectedData).toHaveBeenCalledOnce())
  expect(onRejectedData).toHaveBeenCalledWith(
    expect.objectContaining({ rejectedSourceRecovery: 'fresh-activation' })
  )
})
