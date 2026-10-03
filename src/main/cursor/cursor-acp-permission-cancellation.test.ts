import { expect, it } from 'vitest'
import { cursorAcpPromptsFixture } from './cursor-acp-prompts.test-fixture'

it('cancels a claimed permission exactly once while its answer is committing', async () => {
  const test = cursorAcpPromptsFixture()
  test.permission()
  let release = () => {}
  const pendingCommit = new Promise<void>((resolve) => {
    release = resolve
  })
  const answer = test.answer('allow', () => pendingCommit)
  test.connection.permissionCancellation.cancel()
  test.connection.permissionCancellation.cancel()
  release()
  await expect(answer).rejects.toThrow('no longer waiting')
  await expect(test.answer()).rejects.toThrow('no longer waiting')
  expect(test.connection.respond).toHaveBeenCalledExactlyOnceWith('permission-id', {
    outcome: { outcome: 'cancelled' }
  })
  expect(test.rows.at(-1)?.body.resolution.state).toBe('cancelled')
})

it('does not cancel a permission that already answered and forgets late answers', async () => {
  const test = cursorAcpPromptsFixture()
  test.permission()
  await test.answer()
  test.connection.permissionCancellation.cancel()
  test.connection.permissionCancellation.cancel()
  await expect(test.answer()).rejects.toThrow('no longer waiting')
  expect(test.connection.respond).toHaveBeenCalledExactlyOnceWith('permission-id', {
    outcome: { outcome: 'selected', optionId: 'allow' }
  })
})

it('cancels a late permission during an unconfirmed stop and admits the next confirmed turn', async () => {
  const test = cursorAcpPromptsFixture()
  test.connection.permissionCancellation.cancel()
  expect(test.permission()).toBe(false)
  expect(test.rows).toHaveLength(0)
  expect(test.connection.respond).toHaveBeenCalledExactlyOnceWith('permission-id', {
    outcome: { outcome: 'cancelled' }
  })
  test.connection.permissionCancellation.beginTurn()
  test.permission()
  await test.answer()
  expect(test.connection.respond).toHaveBeenCalledTimes(2)
  expect(test.connection.respond).toHaveBeenLastCalledWith('permission-id', {
    outcome: { outcome: 'selected', optionId: 'allow' }
  })
})

it('revokes the cancellation listener on close instead of replying from a retired owner', () => {
  const test = cursorAcpPromptsFixture()
  test.permission()
  test.prompts.clear()
  test.connection.permissionCancellation.cancel()
  expect(test.connection.respond).not.toHaveBeenCalled()
})
