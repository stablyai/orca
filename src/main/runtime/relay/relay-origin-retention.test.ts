import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelayDrainMessage, RelayRegionRestoredMessage } from './relay-control-protocol'
import type * as RelayHttpClientModule from './relay-http-client'
import type { RelayAssignment } from './relay-http-client'
import type { RelayControlOrigin } from './relay-control-origin'
import type { RelayControlOriginOptions } from './relay-control-origin-options'

type FakeOrigin = {
  options: RelayControlOriginOptions
  pendingRequestCount: number
  availableControl: unknown
  rebind: ReturnType<typeof vi.fn>
  closeNow: ReturnType<typeof vi.fn>
}
function asOrigin(origin: FakeOrigin): RelayControlOrigin {
  return origin as unknown as RelayControlOrigin
}

const fake = vi.hoisted(() => ({
  origins: [] as FakeOrigin[],
  assign: vi.fn(),
  open: vi.fn()
}))
vi.mock('./relay-http-client', async (original) => ({
  ...(await original<typeof RelayHttpClientModule>()),
  requestRelayAssignment: fake.assign
}))
vi.mock('./relay-control-origin', () => ({
  RelayControlOrigin: class {
    assignment: RelayAssignment
    controlGeneration = 7
    controlLeaseExpiresAt = 48 * 60 * 60_000
    pendingRequestCount = 0
    availableControl = {}
    open = fake.open
    rebind = vi.fn().mockResolvedValue(undefined)
    closeNow = vi.fn()
    refreshAuthorization = vi.fn()
    hasLiveControl = vi.fn(() => true)
    constructor(readonly options: RelayControlOriginOptions) {
      this.assignment = options.assignment
      fake.origins.push(this)
    }
    get cellUrl() {
      return this.assignment.cellUrl
    }
    get assignmentEpoch() {
      return this.assignment.assignmentEpoch
    }
    updateAssignment(assignment: RelayAssignment) {
      this.assignment = assignment
    }
  }
}))
import { RelayOriginPool } from './relay-origin-pool'

const source: RelayAssignment = {
  v: 1,
  cellUrl: 'https://source.example.test',
  assignmentEpoch: 1,
  lease: 'synthetic'
}
const target: RelayAssignment = {
  ...source,
  cellUrl: 'https://target.example.test',
  assignmentEpoch: 2
}
const retention: NonNullable<RelayDrainMessage['retention']> = {
  mode: 'finish-existing',
  attemptId: '00000000-0000-4000-8000-000000000001',
  sourceGeneration: 7,
  sourceAssignmentEpoch: 1
}
const drain: RelayDrainMessage = {
  type: 'drain',
  graceMs: 30_000,
  recovery: 'resolve-director',
  retention
}
const restored: RelayRegionRestoredMessage = {
  type: 'region-restored',
  attemptId: retention.attemptId,
  sourceGeneration: 7,
  sourceAssignmentEpoch: 1,
  assignmentEpoch: 3
}
let pool: RelayOriginPool
async function migrate() {
  pool = new RelayOriginPool({
    directorUrl: 'https://director.example.test',
    relayHostId: 'synthetic-host',
    identity: { userId: 'u', profileId: 'p', organizationId: 'o' },
    keypair: {} as never,
    appVersion: 'test',
    mobileSocketWiring: {} as never,
    isCurrent: () => true,
    onStatus: vi.fn(),
    now: () => Date.now(),
    random: () => 0.5
  })
  await pool.openInitial(source, 'synthetic-token')
  const old = fake.origins[0]!
  old.options.onConnectionOwned('quiet', asOrigin(old))
  old.options.onConnectionOwned('second-phone', asOrigin(old))
  fake.assign.mockResolvedValue(target)
  old.options.onDrain(asOrigin(old), drain)
  await vi.advanceTimersByTimeAsync(0)
  expect(pool.activeAssignment).toEqual(target)
  return old
}
describe('finish-existing origin ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    fake.origins.length = 0
    fake.assign.mockReset()
    fake.open.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => {
    pool?.closeNow()
    vi.useRealTimers()
  })
  it('retains quiet and concurrent phone connections past grace and releases after final work', async () => {
    const old = await migrate()
    await vi.advanceTimersByTimeAsync(12 * 60 * 60_000)
    expect(old.closeNow).not.toHaveBeenCalled()
    old.options.onConnectionReleased('quiet', asOrigin(old))
    expect(old.closeNow).not.toHaveBeenCalled()
    old.pendingRequestCount = 1
    old.options.onConnectionReleased('second-phone', asOrigin(old))
    expect(old.closeNow).not.toHaveBeenCalled()
    old.pendingRequestCount = 0
    old.options.onPendingChanged?.(asOrigin(old))
    expect(old.closeNow).toHaveBeenCalledOnce()
  })
  it('does not turn a replayed zero-grace optional drain into forced closure', async () => {
    const old = await migrate()
    old.options.onDrain(asOrigin(old), { ...drain, graceMs: 0 })
    await vi.advanceTimersByTimeAsync(30_001)
    expect(old.closeNow).not.toHaveBeenCalled()
  })
  it('honors a subsequent emergency drain on the retained source', async () => {
    const old = await migrate()
    old.options.onDrain(asOrigin(old), { type: 'drain', graceMs: 10, recovery: 'resolve-director' })
    await vi.advanceTimersByTimeAsync(10)
    expect(old.closeNow).toHaveBeenCalledOnce()
  })
  it('restores only corroborated source authority without rebind or replacing transports', async () => {
    const old = await migrate()
    fake.assign.mockResolvedValue({ ...source, assignmentEpoch: 3 })
    old.options.onRegionRestored?.(asOrigin(old), restored)
    await vi.advanceTimersByTimeAsync(0)
    expect(pool.activeAssignment?.assignmentEpoch).toBe(3)
    expect(pool.controlForBasis('quiet')).toBe(old.availableControl)
    expect(old.rebind).not.toHaveBeenCalled()
    expect(old.closeNow).not.toHaveBeenCalled()
    expect(fake.origins).toHaveLength(2)
    old.options.onDrain(asOrigin(old), drain)
    await vi.advanceTimersByTimeAsync(0)
    expect(pool.activeAssignment?.assignmentEpoch).toBe(3)
  })
  it('retries a one-shot restoration notification after director failure', async () => {
    const old = await migrate()
    fake.assign
      .mockRejectedValueOnce(new Error('director_unavailable'))
      .mockResolvedValue({ ...source, assignmentEpoch: 3 })
    old.options.onRegionRestored?.(asOrigin(old), restored)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(pool.activeAssignment?.assignmentEpoch).toBe(3)
    expect(old.rebind).not.toHaveBeenCalled()
    expect(old.closeNow).not.toHaveBeenCalled()
  })
  it('waits for retained restoration when failed target recovery observes rollback first', async () => {
    const old = await migrate()
    fake.assign.mockResolvedValue({ ...source, assignmentEpoch: 3 })
    const targetOrigin = fake.origins[1]!
    targetOrigin.options.onClose(asOrigin(targetOrigin), 1006)
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.origins).toHaveLength(2)
    expect(old.closeNow).not.toHaveBeenCalled()
    expect(old.rebind).not.toHaveBeenCalled()
    expect(pool.controlForBasis('quiet')).toBe(old.availableControl)
    old.options.onRegionRestored?.(asOrigin(old), restored)
    await vi.advanceTimersByTimeAsync(0)
    expect(pool.activeAssignment?.assignmentEpoch).toBe(3)
    expect(fake.origins).toHaveLength(2)
    expect(old.closeNow).not.toHaveBeenCalled()
  })
  it('fences a late target registration after source restoration', async () => {
    pool = new RelayOriginPool({
      directorUrl: 'https://director.example.test',
      relayHostId: 'test',
      identity: { userId: 'u', profileId: 'p', organizationId: 'o' },
      keypair: {} as never,
      appVersion: 'test',
      mobileSocketWiring: {} as never,
      isCurrent: () => true,
      onStatus: vi.fn()
    })
    await pool.openInitial(source, 'test')
    const old = fake.origins[0]!
    old.options.onConnectionOwned('quiet', asOrigin(old))
    let registered!: () => void
    fake.open.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          registered = resolve
        })
    )
    fake.assign.mockResolvedValue(target)
    old.options.onDrain(asOrigin(old), drain)
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.origins).toHaveLength(2)
    fake.assign.mockResolvedValue({ ...source, assignmentEpoch: 3 })
    old.options.onRegionRestored?.(asOrigin(old), restored)
    await vi.advanceTimersByTimeAsync(0)
    registered()
    await vi.advanceTimersByTimeAsync(0)
    expect(pool.activeAssignment?.assignmentEpoch).toBe(3)
    expect(pool.controlForBasis('quiet')).toBe(old.availableControl)
    expect(fake.origins[1]!.closeNow).toHaveBeenCalledOnce()
    expect(old.closeNow).not.toHaveBeenCalled()
  })
  it('retains a newer report assignment until source grant adoption', async () => {
    pool = new RelayOriginPool({
      directorUrl: 'https://director.example.test',
      relayHostId: 'test',
      identity: { userId: 'u', profileId: 'p', organizationId: 'o' },
      keypair: {} as never,
      appVersion: 'test',
      mobileSocketWiring: {} as never,
      isCurrent: () => true,
      onStatus: vi.fn()
    })
    await pool.openInitial(source, 'test')
    expect(pool.applyAssignmentMetadata(target)).toBe(true)
    expect(pool.activeAssignment).toEqual(source)
    const old = fake.origins[0]!
    old.options.onConnectionOwned('quiet', asOrigin(old))
    fake.assign.mockResolvedValue(source)
    old.options.onDrain(asOrigin(old), drain)
    await vi.advanceTimersByTimeAsync(0)
    expect(pool.activeAssignment).toEqual(target)
    expect(old.closeNow).not.toHaveBeenCalled()
  })
  it.each([
    { ...source, assignmentEpoch: 4 },
    { ...target, assignmentEpoch: 3 }
  ])('refuses rollback when director contradicts the cell notification', async (assignment) => {
    const old = await migrate()
    fake.assign.mockResolvedValue(assignment)
    old.options.onRegionRestored?.(asOrigin(old), restored)
    await vi.advanceTimersByTimeAsync(0)
    expect(pool.activeAssignment).toEqual(target)
    expect(old.rebind).not.toHaveBeenCalled()
  })
  it('ignores a restoration from a different source generation', async () => {
    const old = await migrate()
    fake.assign.mockClear()
    old.options.onRegionRestored?.(asOrigin(old), { ...restored, sourceGeneration: 8 })
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.assign).not.toHaveBeenCalled()
    expect(pool.activeAssignment).toEqual(target)
  })
})
