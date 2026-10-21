import { afterEach, expect, it, vi } from 'vitest'
import {
  ACK_INCARNATION,
  ACK_LEAF,
  ACK_SECOND_LEAF,
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

it('publishes physical-exit retirement before its durable write completes', async () => {
  const f = fixture()
  await f.store.flushPendingOrThrowAsync()
  const published = vi.fn()
  const unsubscribe = f.runtime.onMobileSessionTabsChanged(published)
  const gate = f.authority.pause()
  const exiting = f.runtime.onPtyExit('pty-a', 0, ACK_INCARNATION, { providerExitObserved: true })
  await gate.started.promise
  // Why: a client re-activating the exited pane in this window must already find it retired.
  expect(published).toHaveBeenCalled()
  gate.finish.resolve()
  await exiting
  expect(published).toHaveBeenCalled()
  expect(
    f.store.getWorkspaceSession().terminalLayoutsByTabId[ACK_TAB].ptyIdsByLeafId?.[ACK_LEAF]
  ).toBeUndefined()
  unsubscribe()
})

it('publishes nothing when the exit write lands after a replacement is admitted', async () => {
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

async function exitWithFailedDurableWrite(f: ReturnType<typeof fixture>): Promise<void> {
  await f.store.flushPendingOrThrowAsync()
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  f.authority.failNextWrite()
  await f.runtime.onPtyExit('pty-a', 0, ACK_INCARNATION, { providerExitObserved: true })
  expect(errorSpy).toHaveBeenCalledWith(
    '[runtime] terminal retirement is not yet durable:',
    expect.any(Error)
  )
  errorSpy.mockRestore()
  // The failed write left disk untouched, so a relaunch would still load the exited leaf.
  expect(f.readDisk().workspaceSession.terminalLayoutsByTabId[ACK_TAB]?.ptyIdsByLeafId).toEqual({
    [ACK_LEAF]: 'pty-a',
    [ACK_SECOND_LEAF]: 'pty-b'
  })
}

it('persists a failed exit retirement with the next unrelated profile write', async () => {
  const f = fixture()
  await exitWithFailedDurableWrite(f)
  f.store.addRepo({
    id: 'repo2',
    path: '/tmp/other',
    displayName: 'Other',
    badgeColor: 'gray',
    addedAt: 2
  })
  await f.store.flushPendingOrThrowAsync()
  expect(f.readDisk().workspaceSession.terminalLayoutsByTabId[ACK_TAB]?.ptyIdsByLeafId).toEqual({
    [ACK_SECOND_LEAF]: 'pty-b'
  })
})

it('persists a failed exit retirement with the final quit flush', async () => {
  const f = fixture()
  await exitWithFailedDurableWrite(f)
  await f.quit()
  expect(f.readDisk().workspaceSession.terminalLayoutsByTabId[ACK_TAB]?.ptyIdsByLeafId).toEqual({
    [ACK_SECOND_LEAF]: 'pty-b'
  })
})

it('writes exits retired in the same tick once', async () => {
  const f = fixture()
  await f.store.flushPendingOrThrowAsync()
  const writes = f.authority.captures.length
  await Promise.all([
    f.runtime.onPtyExit('pty-a', 0, ACK_INCARNATION, { providerExitObserved: true }),
    f.runtime.onPtyExit('pty-b', 0, undefined, { providerExitObserved: true })
  ])
  // Why: the first write already carries both retirements; the second has nothing left to fence.
  expect(f.authority.captures.length - writes).toBe(1)
  expect(f.readDisk().workspaceSession.terminalLayoutsByTabId[ACK_TAB]).toBeUndefined()
})
