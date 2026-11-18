import { afterEach, expect, it } from 'vitest'
import { createAcknowledgedTabRetirementFixture } from './acknowledged-terminal-tab-retirement-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'

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
