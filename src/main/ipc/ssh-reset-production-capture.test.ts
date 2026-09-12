import { beforeEach, expect, it, vi } from 'vitest'
import { captureProductionSshResetOperation } from './ssh-reset-production-capture'

const f = vi.hoisted(() => ({
  sessions: new Map(),
  target: { id: 'target', generation: 1 },
  registry: { getTarget: vi.fn() },
  connections: {},
  forwards: {},
  leases: { getSshRemotePtyLeases: vi.fn() },
  bind: vi.fn(),
  capture: vi.fn(),
  select: vi.fn(),
  retain: vi.fn(),
  create: vi.fn(),
  eligible: vi.fn(),
  reserved: vi.fn(),
  live: vi.fn(),
  identity: vi.fn(),
  authority: { assertAuthority: vi.fn(), removeCapturedSession: vi.fn() },
  provider: {},
  mux: {},
  records: {},
  intent: {
    targetId: 'target',
    preparation: { journalDirectory: '/journal', readerVersion: 1 },
    destination: { transport: 'ssh2' }
  },
  selection: {},
  selectionCurrent: vi.fn()
}))
vi.mock('../ssh/ssh-target-registry', () => ({ getSshTargetRegistryStore: () => f.registry }))
vi.mock('./ssh-active-relay-sessions', () => ({ activeSessions: f.sessions }))
vi.mock('./ssh-ipc-context', () => ({
  connectionManager: f.connections,
  portForwardManager: f.forwards,
  persistedStore: f.leases
}))
vi.mock('./ssh-target-destruction-admission', () => ({
  assertSshTargetNotManagedOrPreparing: f.eligible
}))
vi.mock('./ssh-reset-captured-transport', () => ({ captureSshResetTransportRetirement: f.capture }))
vi.mock('./pty/provider/ssh-reset-selection-capture', () => ({
  captureSshResetRetirementSelection: f.select
}))
vi.mock('./ssh-reset-operation', () => ({ createSshResetOperation: f.create }))
vi.mock('./ssh-reset-production-state', () => ({
  getSshResetIntentStore: () => f.records,
  sshResetOperationAuthorities: { retain: f.retain }
}))

beforeEach(() => {
  vi.resetAllMocks()
  f.sessions.clear()
  f.sessions.set('target', { captureResetBinding: f.bind })
  f.registry.getTarget.mockReturnValue(f.target)
  f.bind.mockResolvedValue({ intent: f.intent, mux: f.mux, assertAuthority: f.live })
  f.capture.mockImplementation((options) => {
    options.assertAuthority()
    return { provider: f.provider, mux: f.mux, assertIdentity: f.identity }
  })
  f.select.mockReturnValue({ selection: f.selection, assertCurrent: f.selectionCurrent })
  f.retain.mockReturnValue(f.authority)
  f.create.mockReturnValue({ run: vi.fn() })
  f.leases.getSshRemotePtyLeases.mockReturnValue([])
})

it('composes one exact live capture, provider selection, authority and durable controller', async () => {
  const controller = await captureProductionSshResetOperation('target', f.reserved)
  expect(controller).toBe(f.create.mock.results[0].value)
  expect(f.bind).toHaveBeenCalledTimes(1)
  expect(f.capture).toHaveBeenCalledWith(
    expect.objectContaining({
      session: f.sessions.get('target'),
      connections: f.connections,
      forwards: f.forwards,
      intent: f.intent
    })
  )
  const selection = f.select.mock.calls[0][0]
  expect(selection.expectedProvider).toBe(f.provider)
  expect(selection.readLeases()).toEqual([])
  expect(f.leases.getSshRemotePtyLeases).toHaveBeenCalledWith('target')
  expect(f.retain).toHaveBeenCalledWith(
    expect.objectContaining({
      intent: f.intent,
      selection: f.selection,
      mux: f.mux,
      session: f.sessions.get('target')
    })
  )
  expect(f.create).toHaveBeenCalledWith(
    expect.objectContaining({
      authority: f.authority,
      records: f.records,
      leases: f.leases,
      assertSelectionCurrent: f.selectionCurrent
    })
  )
  const capturedOptions = f.capture.mock.calls[0][0]
  capturedOptions.assertAuthority()
  expect(f.authority.assertAuthority).toHaveBeenCalledTimes(1)
  const proof = vi.fn()
  capturedOptions.removeCapturedSession(proof)
  expect(f.authority.removeCapturedSession).toHaveBeenCalledWith(proof)
})

it('keeps retained authority checks on captured identity, without weakening live binding checks', async () => {
  await captureProductionSshResetOperation('target', f.reserved)
  const authorityOptions = f.retain.mock.calls[0][0]
  f.live.mockClear()
  authorityOptions.assertCapturedIdentity()
  expect(f.identity).toHaveBeenCalledTimes(1)
  expect(f.live).not.toHaveBeenCalled()
  authorityOptions.assertLiveAuthority()
  expect(f.live).toHaveBeenCalledTimes(1)
  f.reserved.mockImplementation(() => {
    throw new Error('reservation lost')
  })
  expect(authorityOptions.assertCapturedIdentity).toThrow('reservation lost')
})

it('rechecks eligibility after asynchronous host status before capturing resources', async () => {
  let resolve!: (value: unknown) => void
  f.bind.mockReturnValue(
    new Promise((done) => {
      resolve = done
    })
  )
  const pending = captureProductionSshResetOperation('target', f.reserved)
  f.eligible.mockImplementation(() => {
    throw new Error('outgoing preparation')
  })
  resolve({ intent: f.intent, mux: f.mux, assertAuthority: f.live })
  await expect(pending).rejects.toThrow('outgoing preparation')
  expect(f.capture).not.toHaveBeenCalled()
  expect(f.retain).not.toHaveBeenCalled()
})

it('does not retain authority when full local selection cannot be proven', async () => {
  f.select.mockImplementation(() => {
    throw new Error('selection changed')
  })
  await expect(captureProductionSshResetOperation('target', f.reserved)).rejects.toThrow(
    'selection changed'
  )
  expect(f.retain).not.toHaveBeenCalled()
  expect(f.create).not.toHaveBeenCalled()
})

it('refuses an older in-memory-only host before capturing resources', async () => {
  f.bind.mockResolvedValue({ intent: { targetId: 'target' }, mux: f.mux, assertAuthority: f.live })
  await expect(captureProductionSshResetOperation('target', f.reserved)).rejects.toThrow(
    'durable_preparation_required'
  )
  expect(f.capture).not.toHaveBeenCalled()
  expect(f.retain).not.toHaveBeenCalled()
})

it('refuses an unverified execution destination before capturing resources', async () => {
  f.bind.mockResolvedValue({
    intent: { ...f.intent, destination: undefined },
    mux: f.mux,
    assertAuthority: f.live
  })
  await expect(captureProductionSshResetOperation('target', f.reserved)).rejects.toThrow(
    'execution_destination_required'
  )
  expect(f.capture).not.toHaveBeenCalled()
  expect(f.retain).not.toHaveBeenCalled()
})

it('requires a negotiated reader before admitting reset effects', async () => {
  f.bind.mockResolvedValue({
    intent: { ...f.intent, preparation: { journalDirectory: '/journal' } },
    mux: f.mux,
    assertAuthority: f.live
  })
  await expect(captureProductionSshResetOperation('target', f.reserved)).rejects.toThrow(
    'preparation_reader_required'
  )
  expect(f.capture).not.toHaveBeenCalled()
  expect(f.retain).not.toHaveBeenCalled()
})
