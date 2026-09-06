import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_ID,
  HEADLESS_LEAF_ID,
  store,
  syncSinglePty,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-test-fixtures.spec'

describe('terminal tab titles', () => {
  it('reports renderer tab labels separately from pane OSC titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime, 'pty-1', { tabTitle: 'My tab' })
    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
    const [terminal] = (await runtime.listTerminals()).terminals
    expect(terminal).toMatchObject({ tabTitle: 'My tab', title: 'Codex working' })
    expect(await runtime.showTerminal(terminal.handle)).toMatchObject({
      tabTitle: 'My tab',
      title: 'Codex working'
    })
    await runtime.renameTerminal(terminal.handle, 'Renamed tab')
    runtime.onPtyData('pty-1', '\x1b]0;Next prompt\x07', 200)
    expect(await runtime.showTerminal(terminal.handle)).toMatchObject({
      tabTitle: 'Renamed tab',
      title: 'Next prompt'
    })
  })

  it('reads persisted custom titles and respects clearing after rename', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const tab = session.tabsByWorktree[TEST_WORKTREE_ID]![0]
    tab.customTitle = 'Persisted label'
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'persisted-title-pty' })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: tab.id,
      leafId: HEADLESS_LEAF_ID
    })
    runtime.onPtyData('persisted-title-pty', '\x1b]0;Shell prompt\x07', 100)
    expect(await runtime.showTerminal(created.handle)).toMatchObject({
      tabTitle: 'Persisted label',
      title: 'Shell prompt'
    })
    await runtime.renameTerminal(created.handle, 'New label')
    runtime.onPtyData('persisted-title-pty', '\x1b]0;New prompt\x07', 200)
    expect(await runtime.showTerminal(created.handle)).toMatchObject({
      tabTitle: 'New label',
      title: 'New prompt'
    })
    await runtime.renameTerminal(created.handle, null)
    expect(await runtime.showTerminal(created.handle)).toMatchObject({ tabTitle: null })
  })

  it('keeps create and rename labels through OSC updates in list and show', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'tab-title-pty' })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      title: 'Codex: skills review'
    })
    expect(created).toMatchObject({ tabTitle: 'Codex: skills review' })
    runtime.onPtyData('tab-title-pty', '\x1b]0;orchestration-v3\x07', 100)
    const assertTitles = async (tabTitle: string | null, title: string) => {
      expect((await runtime.listTerminals()).terminals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ handle: created.handle, tabTitle, title })
        ])
      )
      expect(await runtime.showTerminal(created.handle)).toMatchObject({ tabTitle, title })
    }
    await assertTitles('Codex: skills review', 'orchestration-v3')
    await runtime.renameTerminal(created.handle, 'Review renamed')
    runtime.onPtyData('tab-title-pty', '\x1b]0;Codex working\x07', 200)
    await assertTitles('Review renamed', 'Codex working')
    await runtime.renameTerminal(created.handle, null)
    await assertTitles(null, 'Codex working')
  })
})
