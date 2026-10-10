import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it, vi } from 'vitest'
import { createRuntime, TEST_WORKTREE_ID } from './orca-runtime-test-fixtures.spec'

async function createBackgroundTerminal(title?: string) {
  const runtime = createRuntime()
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'title-test-pty' })),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const terminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
    presentation: 'background',
    ...(title ? { title } : {})
  })
  return { runtime, terminal }
}

describe('background terminal manual names in mobile session tabs', () => {
  it('keeps an explicit creation name after live process titles change', async () => {
    const { runtime, terminal } = await createBackgroundTerminal('Radar')
    for (const title of ['Cowork', 'Codex Working']) {
      runtime.onPtyData('title-test-pty', `\x1b]0;${title}\x07`, Date.now())
      const snapshot = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      expect(snapshot.tabs).toEqual([
        expect.objectContaining({
          title: 'Radar',
          parentTabId: terminal.tabId,
          terminal: terminal.handle
        })
      ])
    }
  })

  it('keeps a later rename and restores live titles when that rename is cleared', async () => {
    const { runtime, terminal } = await createBackgroundTerminal('Radar')
    await runtime.renameTerminal(terminal.handle, 'Renamed Radar')
    runtime.onPtyData('title-test-pty', '\x1b]0;Cowork\x07', Date.now() + 1)
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs[0]?.title).toBe(
      'Renamed Radar'
    )
    await runtime.renameTerminal(terminal.handle, null)
    runtime.onPtyData('title-test-pty', '\x1b]0;Codex Working\x07', Date.now() + 2)
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs[0]?.title).toBe(
      'Codex Working'
    )
  })

  it('retains live titles for a terminal without an explicit name', async () => {
    const { runtime } = await createBackgroundTerminal()
    runtime.onPtyData('title-test-pty', '\x1b]0;Cowork\x07', Date.now())
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs[0]?.title).toBe(
      'Cowork'
    )
  })
})
