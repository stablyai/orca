import { expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import { retireSshRemotePtyLeaseSelection } from './ssh-pty-reset-retirement'
import type { SshPtyLeaseOperations } from './ssh-pty-lease-operations'

function fixture() {
  const selection: SshRemotePtyLease[] = ['a', 'b'].map((ptyId) => ({
    targetId: 'target',
    ptyId,
    state: 'attached',
    createdAt: 1,
    updatedAt: 2,
    tabId: 'tab',
    leafId: 'leaf'
  }))
  const operations: SshPtyLeaseOperations = {
    state: { sshRemotePtyLeases: structuredClone(selection) } as PersistedState,
    toStoredPtyId: (_target, id) => id,
    toComparablePtyId: (_target, id) => id,
    clearBindingsForTarget: vi.fn(),
    clearBindingsForLeases: vi.fn(),
    flush: vi.fn(),
    flushDurableStateOrThrowAsync: vi.fn(async () => {})
  }
  const retire = () => retireSshRemotePtyLeaseSelection(operations, 'target', selection, 100)
  return { operations, selection, retire }
}

it('retires the full exact selection without changing pane bindings or evidence', async () => {
  const f = fixture()
  for (const lease of f.selection) {
    Object.freeze(lease)
  }
  await f.retire()
  expect(f.operations.state.sshRemotePtyLeases).toEqual(
    f.selection.map((lease) => ({ ...lease, state: 'expired', updatedAt: 100 }))
  )
  expect(f.operations.clearBindingsForTarget).not.toHaveBeenCalled()
  expect(f.operations.clearBindingsForLeases).not.toHaveBeenCalled()
  expect(f.selection.every((lease) => lease.state === 'attached')).toBe(true)
})

it.each(['replacement', 'restored-original', 'missing', 'duplicate'])(
  'rechecks retirement after later awaits without mutating %s evidence',
  async (change) => {
    const f = fixture()
    const { assertRetired } = await f.retire()
    expect(assertRetired).not.toThrow()
    const leases = f.operations.state.sshRemotePtyLeases!
    if (change === 'replacement') {
      leases[1] = { ...f.selection[1], updatedAt: 500 }
    }
    if (change === 'restored-original') {
      leases[1] = { ...f.selection[1] }
    }
    if (change === 'missing') {
      leases.pop()
    }
    if (change === 'duplicate') {
      leases.push({ ...leases[1] })
    }
    const before = structuredClone(leases)
    expect(assertRetired).toThrow()
    expect(leases).toEqual(before)
    expect(f.operations.flushDurableStateOrThrowAsync).toHaveBeenCalledTimes(1)
  }
)

it('reflushes an exact retry after an uncertain write without recomputing timestamps', async () => {
  const f = fixture()
  vi.mocked(f.operations.flushDurableStateOrThrowAsync).mockRejectedValueOnce(
    new Error('write uncertain')
  )
  await expect(f.retire()).rejects.toThrow('write uncertain')
  const before = structuredClone(f.operations.state.sshRemotePtyLeases)
  await f.retire()
  expect(f.operations.state.sshRemotePtyLeases).toEqual(before)
  expect(f.operations.flushDurableStateOrThrowAsync).toHaveBeenCalledTimes(2)
})

it('accepts a partially applied exact selection and leaves unselected leases untouched', async () => {
  const f = fixture()
  const leases = f.operations.state.sshRemotePtyLeases!
  Object.assign(leases[0], { state: 'expired', updatedAt: 100 })
  const other: SshRemotePtyLease = { ...leases[1], ptyId: 'other' }
  leases.push(other)
  await f.retire()
  expect(other.state).toBe('attached')
  expect(leases[1].state).toBe('expired')
})

it.each([
  'missing',
  'timestamp',
  'binding',
  'pending-kill',
  'superseded',
  'recycled',
  'duplicate-state',
  'duplicate-selection'
])('refuses %s before changing any member', async (change) => {
  const f = fixture()
  const leases = f.operations.state.sshRemotePtyLeases!
  if (change === 'missing') {
    leases.pop()
  }
  if (change === 'timestamp') {
    leases[1].updatedAt = 3
  }
  if (change === 'binding') {
    leases[1].tabId = 'replacement'
  }
  if (change === 'pending-kill') {
    leases[1].pendingKill = { requestedAt: 3, incarnationId: 'new', attempts: 0 }
  }
  if (change === 'superseded') {
    leases[1].supersededBy = 'other'
  }
  if (change === 'recycled') {
    leases[1].relayIdRecycled = true
  }
  if (change === 'duplicate-state') {
    leases.push({ ...leases[1] })
  }
  if (change === 'duplicate-selection') {
    f.selection.push({ ...f.selection[1] })
  }
  const before = structuredClone(leases)
  await expect(f.retire()).rejects.toThrow()
  expect(leases).toEqual(before)
  expect(f.operations.flushDurableStateOrThrowAsync).not.toHaveBeenCalled()
})

it('refuses a replacement installed during the durability await without touching it', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<void>()
  vi.mocked(f.operations.flushDurableStateOrThrowAsync).mockReturnValue(pending.promise)
  const retiring = f.retire()
  const replacement: SshRemotePtyLease = { ...f.selection[1], updatedAt: 500 }
  f.operations.state.sshRemotePtyLeases![1] = replacement
  pending.resolve()
  await expect(retiring).rejects.toThrow('selection_changed')
  expect(replacement.state).toBe('attached')
})

it('does not downgrade terminated leases or change preexisting expired evidence', async () => {
  const f = fixture()
  f.selection[0].state = 'terminated'
  f.selection[1].state = 'expired'
  f.operations.state.sshRemotePtyLeases = structuredClone(f.selection)
  await f.retire()
  expect(f.operations.state.sshRemotePtyLeases).toEqual(f.selection)
  expect(f.operations.flushDurableStateOrThrowAsync).toHaveBeenCalledOnce()
})
