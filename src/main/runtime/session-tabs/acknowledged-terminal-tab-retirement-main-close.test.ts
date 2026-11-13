// Main-owned counterparts to acknowledged-terminal-tab-retirement.test.ts: close waits for layout durability without a window-ack race.
import { afterEach, expect, it, vi } from 'vitest'
import {
  ACK_LEAF,
  ACK_SECOND_LEAF,
  ACK_TAB,
  createAcknowledgedTabRetirementFixture
} from './acknowledged-terminal-tab-retirement-fixture'
import '../../persistence/terminal-topology/pane-ownership/terminal-topology-membership'
import { _resetClosedPaneFencesForTests } from '../../persistence/terminal-topology/pane-ownership/closed-pane-binding-fence'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const fixtures: ReturnType<typeof createAcknowledgedTabRetirementFixture>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.dispose()
  }
  vi.restoreAllMocks()
  // Reused tab ids must not inherit an earlier test's close fence.
  _resetClosedPaneFencesForTests()
})
function fixture(bound = false) {
  const result = createAcknowledgedTabRetirementFixture(bound)
  fixtures.push(result)
  const stopped: string[] = []
  result.runtime.setPtyController({
    write: () => true,
    kill: (ptyId: string) => {
      stopped.push(ptyId)
      return true
    },
    getForegroundProcess: async () => null
  })
  return { ...result, stopped }
}

it("stops a sibling a partial mobile snapshot omitted, from main's own panes", async () => {
  const f = fixture(true)
  f.publish(true, 2, [ACK_LEAF])
  await expect(f.close()).resolves.toEqual({ closed: true, retirementConfirmed: true })
  expect(f.stopped).toEqual(expect.arrayContaining(['pty-a', 'pty-b']))
  expect(
    f.store.getWorkspaceSession().terminalLayoutsByTabId[ACK_TAB]?.ptyIdsByLeafId?.[ACK_SECOND_LEAF]
  ).toBeUndefined()
})

// Main-owned close waits for durable layout, matching window-owned retirement's acknowledgement boundary.
it("answers the close only once main's layout write is durable", async () => {
  const f = fixture(true)
  await f.store.flushPendingOrThrowAsync()
  const gate = f.authority.pause()
  let answered = false
  const closing = f.close().then((result) => {
    answered = true
    return result
  })
  await gate.started.promise
  expect(answered).toBe(false)
  gate.finish.resolve()
  await expect(closing).resolves.toEqual({ closed: true, retirementConfirmed: true })
  expect(f.hasTab()).toBe(false)
})
