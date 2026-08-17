import { expect, it, vi } from 'vitest'
import { StructuredAgentSessionReadableRestorer } from './structured-agent-session-readable-restorer'
import { StructuredAgentSessionRestartRestoreGate } from './structured-agent-session-restart-restore-gate'
import { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import { restoreStructuredAgentSessionRead } from './structured-agent-session-read-restore'

vi.mock('./structured-agent-session-read-restore', () => ({
  restoreStructuredAgentSessionRead: vi.fn(async () => ({ hasProviderChild: false }))
}))

it('restores later room IDs after empty startup, deduplicates opens, and permits reopen/retry', async () => {
  const sessions = new Map<string, unknown>()
  const tasks = new StructuredAgentSessionTaskQueue()
  const gate = new StructuredAgentSessionRestartRestoreGate()
  const restorer = new StructuredAgentSessionReadableRestorer({
    store: { listRecords: () => ['one', 'two'].map((sessionId) => ({ sessionId })) } as never,
    journalRoot: 'unused',
    supportsRecord: () => true,
    reconcile: async () => null,
    resolveRecovery: async () => undefined,
    serialize: (id, task) => tasks.serialize(id, task),
    hasSession: (id) => sessions.has(id),
    onReadable: (id, value) => {
      sessions.set(id, value)
    },
    restoreHandoff: async () => undefined
  })
  const restore = (ids: string[]) => gate.run(() => restorer.restore(ids))
  await restore([])
  await Promise.all([restore(['one']), restore(['two']), restore(['one'])])
  expect(restoreStructuredAgentSessionRead).toHaveBeenCalledTimes(2)
  const retained = sessions.get('one')
  await restore(['one'])
  expect(sessions.get('one')).toBe(retained)
  sessions.delete('one')
  vi.mocked(restoreStructuredAgentSessionRead).mockRejectedValueOnce(new Error('temporary'))
  await expect(restore(['one'])).rejects.toThrow('temporary')
  await restore(['one'])
  expect(sessions.has('one')).toBe(true)
  expect(restoreStructuredAgentSessionRead).toHaveBeenCalledTimes(4)
})
