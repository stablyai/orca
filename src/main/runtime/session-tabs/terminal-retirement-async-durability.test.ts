import { afterEach, expect, it, vi } from 'vitest'
import {
  ACK_INCARNATION,
  ACK_LEAF,
  ACK_TAB,
  createAcknowledgedTabRetirementFixture
} from './acknowledged-terminal-tab-retirement-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/workspace-layout/layout-owner-switch'

// The window's acknowledged close; a layout-owner build closes in main without one, and the twin
// of that case is in acknowledged-terminal-tab-retirement-main-close.test.ts.
const itSwitchOff = it.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)

const fixtures: Awaited<ReturnType<typeof createAcknowledgedTabRetirementFixture>>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.dispose()
  }
})
async function fixture() {
  const result = await createAcknowledgedTabRetirementFixture(true)
  fixtures.push(result)
  return result
}

itSwitchOff('withholds the acknowledged close until its host retirement is durable', async () => {
  const f = await fixture()
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
  await expect(closing).resolves.toEqual({ closed: true, retirementConfirmed: true })
  expect(f.hasTab()).toBe(false)
})

it('publishes physical-exit retirement before its durable write completes', async () => {
  const f = await fixture()
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
