import { afterEach, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
vi.mock('../../../../../node-runtime/pinned-zip-members', () => ({
  extractPinnedZipMembers: () => {
    throw new Error('Inbox fixtures must not install a runtime')
  }
}))
const h = createOrchestrationRpcHarness()
afterEach(() => h.cleanup())

it('reads an exact consumed report beyond recent history without consuming other mail', async () => {
  const { db, ctx } = h.setup()
  const call = (name: string, params: Record<string, unknown>) => h.call(name, params, ctx)
  const report = db.insertMessage({
    from: 'a',
    to: 'b',
    subject: 'old',
    body: 'full'.repeat(2_000)
  })
  db.markAsRead([report.id])
  for (let i = 0; i < 21; i++) {
    db.insertMessage({ from: 'a', to: 'c', subject: 'new' })
  }
  const result = await call('orchestration.inbox', { id: report.id, terminal: 'b' })
  expect(result).toMatchObject({ count: 1, messages: [{ id: report.id, body: report.body }] })
  expect(await call('orchestration.inbox', { id: report.id, terminal: 'c' })).toEqual({
    count: 0,
    messages: []
  })
  expect(db.getUnreadMessages('c')).toHaveLength(21)
})
