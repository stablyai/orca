import { afterEach, expect, it, vi } from 'vitest'
import { identity } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { setupDelegatedPtyOperations as setup } from './orcad-delegated-pty-operations-fixture'
afterEach(() => vi.restoreAllMocks())

it.each(['inspectProcess', 'inspectCwd', 'inspectTerminalInfo'] as const)(
  'does not dispatch %s after its budget expires behind an operation',
  async (method) => {
    const f = setup()
    let now = 100
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const dispatch = f.transport.getMockImplementation()!
    let release!: () => void
    f.transport.mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return dispatch(...args)
    })
    const control = f.operations.control(identity.terminalId, 'resize', {
      kind: 'resize',
      cols: 80,
      rows: 24
    })
    await Promise.resolve()
    const inspection = f.operations[method](identity.terminalId, 50)
    now = 151
    release()
    await control
    await expect(inspection).rejects.toThrow('inspection_deadline_expired')
    expect(f.transport).toHaveBeenCalledOnce()
  }
)

it('sends exact operation IDs and epoch through a published claim', async () => {
  const fixture = setup(2)
  await expect(
    fixture.operations.input(identity.terminalId, 'input', 'hello', 2)
  ).resolves.toMatchObject({ outcome: 'applied', inputEpoch: 2 })
  await expect(
    fixture.operations.control(identity.terminalId, 'resize', {
      kind: 'resize',
      cols: 80,
      rows: 24
    })
  ).resolves.toMatchObject({ controlId: 'resize' })
  expect(fixture.transport.mock.calls[0][1]).toMatchObject({
    inputId: 'input',
    inputEpoch: 2,
    destinationClaim: { generation: 1, claimId: 'claim' }
  })
})

it.each(['aborted', 'disconnected', 'unreconciled', 'claim', 'publication'])(
  'refuses cached operations after authority becomes %s',
  async (change) => {
    const fixture = setup()
    if (change === 'aborted') {
      fixture.controller.abort()
    }
    if (change === 'disconnected') {
      fixture.isActive.mockReturnValue(false)
    }
    if (change === 'unreconciled') {
      fixture.isCommitReconciled.mockReturnValue(false)
    }
    if (change === 'claim') {
      Object.assign(fixture.snapshot, { delegatedClaim: { generation: 2, claimId: 'new' } })
    }
    if (change === 'publication') {
      Object.assign(fixture.snapshot, { phase: 'committed' })
    }
    await expect(fixture.operations.input(identity.terminalId, 'id', 'data', 0)).rejects.toThrow()
    await expect(
      fixture.operations.control(identity.terminalId, 'id', { kind: 'shutdown', immediate: true })
    ).rejects.toThrow()
    expect(fixture.transport).not.toHaveBeenCalled()
  }
)

it('rejects a reply that arrives after loss of authority', async () => {
  const fixture = setup()
  const dispatch = fixture.transport.getMockImplementation()!
  fixture.transport.mockImplementationOnce(async (method, params) => {
    const result = await dispatch(method, params)
    fixture.isActive.mockReturnValue(false)
    return result
  })
  await expect(fixture.operations.input(identity.terminalId, 'id', 'data', 0)).rejects.toThrow(
    'unverifiable'
  )
  expect(fixture.transport).toHaveBeenCalledOnce()
})

it.each([
  { inputId: 'wrong' },
  { inputEpoch: 1 },
  { terminalId: 'wrong' },
  { outcome: 'success' },
  { duplicate: undefined }
])('rejects mismatched input evidence %#', async (patch) => {
  const fixture = setup()
  fixture.transport.mockResolvedValueOnce({
    ...identity,
    version: 1,
    outcome: 'applied',
    duplicate: false,
    inputId: 'id',
    inputEpoch: 0,
    controlId: undefined,
    ...patch
  } as never)
  await expect(fixture.operations.input(identity.terminalId, 'id', 'data', 0)).rejects.toThrow()
})

it('rejects an operation addressed to another terminal before dispatch', async () => {
  const fixture = setup()
  await expect(fixture.operations.control('other', 'id', { kind: 'clearBuffer' })).rejects.toThrow(
    'identity_mismatch'
  )
  expect(fixture.transport).not.toHaveBeenCalled()
})

it('retains the attempt before dispatch and after an uncertain transport reply', async () => {
  const fixture = setup()
  fixture.transport.mockImplementationOnce(async () => {
    expect(fixture.readInputs().entries).toEqual([
      { inputId: 'input', data: 'data', phase: 'attempted' }
    ])
    throw new Error('reply lost')
  })
  await expect(fixture.operations.input(identity.terminalId, 'input', 'data', 0)).rejects.toThrow(
    'reply lost'
  )
  expect(fixture.readInputs().entries[0].phase).toBe('attempted')
  await expect(fixture.operations.settleInput(identity.terminalId, 'input', 0)).rejects.toThrow(
    'unproven'
  )
  await fixture.operations.input(identity.terminalId, 'input', 'data', 0)
  expect(fixture.readInputs().entries).toEqual([
    { inputId: 'input', data: 'data', phase: 'applied' }
  ])
})

it('retains retirement intent after an uncertain reply and blocks new input', async () => {
  const fixture = setup()
  await fixture.operations.input(identity.terminalId, 'input', 'data', 0)
  await expect(fixture.operations.retireInput(identity.terminalId, ['input'], 0)).rejects.toThrow(
    'unsettled'
  )
  await fixture.operations.settleInput(identity.terminalId, 'input', 0)
  fixture.transport.mockImplementationOnce(async () => {
    expect(fixture.readInputs().retiring).toBe(true)
    throw new Error('retirement reply lost')
  })
  await expect(fixture.operations.retireInput(identity.terminalId, ['input'], 0)).rejects.toThrow(
    'reply lost'
  )
  expect(fixture.readInputs()).toMatchObject({ epoch: 0, retiring: true })
  await expect(fixture.operations.input(identity.terminalId, 'new', 'data', 0)).rejects.toThrow(
    'in_progress'
  )
  expect(fixture.transport).toHaveBeenCalledTimes(2)
})

it('orders input, control and retirement and snapshots queued payloads', async () => {
  const fixture = setup()
  let finish!: () => void
  const dispatch = fixture.transport.getMockImplementation()!
  fixture.transport.mockImplementationOnce(async (method, params) => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return dispatch(method, params)
  })
  const input = fixture.operations.input(identity.terminalId, 'input', 'data', 0)
  const resize = { kind: 'resize' as const, cols: 80, rows: 24 }
  const control = fixture.operations.control(identity.terminalId, 'resize', resize)
  const settlement = fixture.operations.settleInput(identity.terminalId, 'input', 0)
  const ids = ['input']
  const retired = fixture.operations.retireInput(identity.terminalId, ids, 0)
  resize.cols = 999
  ids.push('not-acknowledged')
  await Promise.resolve()
  expect(fixture.transport).toHaveBeenCalledOnce()
  fixture.transport.mockImplementationOnce(dispatch)
  fixture.transport.mockImplementationOnce(
    async () => ({ ...identity, version: 1, inputEpoch: 1, retired: 1 }) as never
  )
  finish()
  await Promise.all([input, control, settlement, retired])
  expect(fixture.transport.mock.calls[1][1]).toMatchObject({ control: { cols: 80 } })
  expect(fixture.transport.mock.calls[2][1]).toMatchObject({ inputIds: ['input'] })
})

it('refuses queued controls after disconnect while the earlier input is in flight', async () => {
  const fixture = setup()
  let finish!: () => void
  const dispatch = fixture.transport.getMockImplementation()!
  fixture.transport.mockImplementationOnce(async (method, params) => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return dispatch(method, params)
  })
  const input = fixture.operations.input(identity.terminalId, 'input', 'data', 0)
  const control = fixture.operations.control(identity.terminalId, 'stop', {
    kind: 'shutdown',
    immediate: true
  })
  const results = Promise.allSettled([input, control])
  await Promise.resolve()
  fixture.isActive.mockReturnValue(false)
  finish()
  expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected'])
  expect(fixture.transport).toHaveBeenCalledOnce()
})
