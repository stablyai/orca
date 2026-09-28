import { afterEach, expect, it, vi } from 'vitest'
import {
  ACK_INCARNATION,
  ACK_LEAF,
  ACK_TAB,
  createAcknowledgedTabRetirementFixture
} from './acknowledged-terminal-tab-retirement-fixture'

const fixtures: ReturnType<typeof createAcknowledgedTabRetirementFixture>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.dispose()
  }
})
function fixture() {
  const result = createAcknowledgedTabRetirementFixture(true)
  fixtures.push(result)
  return result
}

it('withholds the acknowledged close until its host retirement is durable', async () => {
  const f = fixture()
  let acknowledged = false
  const closing = f.close().then((result) => {
    acknowledged = true
    return result
  })
  await f.entered.promise
  const gate = f.authority.pause()
  f.acknowledgement.resolve()
  await gate.started.promise
  expect(acknowledged).toBe(false)
  gate.finish.resolve()
  await expect(closing).resolves.toEqual({ closed: true })
  expect(f.hasTab()).toBe(false)
})

it('publishes physical-exit retirement only after durability', async () => {
  const f = fixture()
  await f.store.flushPendingOrThrowAsync()
  const published = vi.fn()
  const unsubscribe = f.runtime.onMobileSessionTabsChanged(published)
  const gate = f.authority.pause()
  const exiting = f.runtime.onPtyExit('pty-a', 0, ACK_INCARNATION, { providerExitObserved: true })
  await gate.started.promise
  expect(published).not.toHaveBeenCalled()
  gate.finish.resolve()
  await exiting
  expect(published).toHaveBeenCalled()
  expect(
    f.store.getWorkspaceSession().terminalLayoutsByTabId[ACK_TAB].ptyIdsByLeafId?.[ACK_LEAF]
  ).toBeUndefined()
  unsubscribe()
})

it('does not publish a delayed exit over a newly admitted incarnation', async () => {
  const f = fixture()
  await f.store.flushPendingOrThrowAsync()
  const published = vi.fn()
  const unsubscribe = f.runtime.onMobileSessionTabsChanged(published)
  const gate = f.authority.pause()
  const exiting = f.runtime.onPtyExit('pty-a', 0, ACK_INCARNATION, { providerExitObserved: true })
  await gate.started.promise
  f.runtime.onPtySpawned('pty-a', 'new-incarnation')
  published.mockClear()
  gate.finish.resolve()
  await exiting
  expect(published).not.toHaveBeenCalled()
  unsubscribe()
})
