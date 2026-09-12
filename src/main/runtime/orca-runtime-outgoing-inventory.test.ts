import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { fenceOutgoingPtyRegistrations } from './outgoing-pty-registration-fence'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { DISCONNECTED_PTY_RECORD_MAX } from './orca-runtime-postlude'

const sourceId = toAppSshPtyId('source', 'pty')
const otherId = toAppSshPtyId('other', 'pty')
class Runtime extends OrcaRuntimeService {
  refresh(connectionId = 'source') {
    return this.refreshPtyWorktreeRecordsWithControllerInventory([], null, undefined, connectionId)
  }
  record(id: string) {
    return this.recordPtyWorktree(id, 'folder:replacement', { connected: true, title: 'changed' })
  }
  records() {
    return this.ptysById
  }
  prune() {
    this.pruneDisconnectedPtyRecords()
  }
}

it.each([true, false])(
  'refuses inventory before mutation when source is listed=%s',
  async (listed) => {
    const runtime = new Runtime()
    runtime.registerPty(sourceId, 'folder:source', 'source')
    const before = runtime.records().get(sourceId)!
    const saved = structuredClone(before)
    const exit = vi.spyOn(runtime, 'onPtyExit')
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      hasPty: () => false,
      listProcesses: async () =>
        listed ? [{ id: sourceId, worktreeId: 'folder:replacement', title: 'changed' }] : []
    } as never)
    fenceOutgoingPtyRegistrations(runtime, [sourceId])
    await expect(runtime.refresh()).resolves.toBeNull()
    expect(runtime.records().get(sourceId)).toBe(before)
    expect(before).toEqual(saved)
    expect(exit).not.toHaveBeenCalled()
  }
)

it('checks a cleanup fence installed while inventory is in flight', async () => {
  const runtime = new Runtime()
  const pending = Promise.withResolvers<{ id: string; worktreeId: string }[]>()
  const listProcesses = vi.fn(() => pending.promise)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses
  } as never)
  const refresh = runtime.refresh()
  expect(listProcesses).toHaveBeenCalledOnce()
  fenceOutgoingPtyRegistrations(runtime, [sourceId])
  pending.resolve([
    { id: otherId, worktreeId: 'folder:other' },
    { id: sourceId, worktreeId: 'folder:source' }
  ])
  await expect(refresh).resolves.toBeNull()
  expect(runtime.records().size).toBe(0)
})

it('fences direct record creation and mutation without blocking another target inventory', async () => {
  const runtime = new Runtime()
  runtime.registerPty(sourceId, 'folder:source', 'source')
  fenceOutgoingPtyRegistrations(runtime, [sourceId, 'absent'])
  expect(() => runtime.record(sourceId)).toThrow('source_registration_fenced')
  expect(() => runtime.record('absent')).toThrow('source_registration_fenced')
  expect(runtime.records().has('absent')).toBe(false)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => [{ id: otherId, worktreeId: 'folder:other' }]
  } as never)
  expect(await runtime.refresh('other')).not.toBeNull()
  expect(runtime.records().get(otherId)?.worktreeId).toBe('folder:other')
  expect(runtime.records().get(sourceId)?.worktreeId).toBe('folder:source')
})

it('keeps a held source record out of ordinary disconnected-record pruning', () => {
  const runtime = new Runtime()
  runtime.registerPty(sourceId, 'folder:source', 'source')
  const held = runtime.records().get(sourceId)!
  held.connected = false
  held.disconnectedAt = 0
  fenceOutgoingPtyRegistrations(runtime, [sourceId])
  for (let index = 0; index <= DISCONNECTED_PTY_RECORD_MAX; index++) {
    const id = `ordinary-${index}`
    runtime.records().set(id, { ...held, ptyId: id, connectionId: null, disconnectedAt: index + 1 })
  }
  runtime.prune()
  expect(runtime.records().get(sourceId)).toBe(held)
  expect(runtime.records().has('ordinary-0')).toBe(false)
  expect(runtime.records().size).toBe(DISCONNECTED_PTY_RECORD_MAX + 1)
})
