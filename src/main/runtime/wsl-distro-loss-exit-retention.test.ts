import { afterEach, expect, it } from 'vitest'
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

async function boundFixture() {
  const f = createAcknowledgedTabRetirementFixture(true)
  fixtures.push(f)
  await f.store.flushPendingOrThrowAsync()
  return f
}

// verify-15b 5e: after `wsl --terminate` the kept tabs opened fresh sessions on relaunch.
it('keeps a pane whose WSL distro went away bound to its session across a relaunch', async () => {
  const f = await boundFixture()
  await f.runtime.onPtyExit('pty-a', -1, ACK_INCARNATION, {
    providerExitObserved: true,
    hostLost: true
  })
  await f.quit()
  const saved = f.readDisk().workspaceSession
  expect(saved.terminalLayoutsByTabId[ACK_TAB]?.ptyIdsByLeafId).toEqual({
    [ACK_LEAF]: 'pty-a',
    [ACK_SECOND_LEAF]: 'pty-b'
  })
  expect(saved.terminalPtyIncarnationsByPaneKey?.[`${ACK_TAB}:${ACK_LEAF}`]).toBe(ACK_INCARNATION)
})

it('still retires the pane of a shell that exited on its own', async () => {
  const f = await boundFixture()
  await f.runtime.onPtyExit('pty-a', 1, ACK_INCARNATION, { providerExitObserved: true })
  await f.quit()
  expect(f.readDisk().workspaceSession.terminalLayoutsByTabId[ACK_TAB]?.ptyIdsByLeafId).toEqual({
    [ACK_SECOND_LEAF]: 'pty-b'
  })
})
