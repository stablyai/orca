import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'

// With no desktop window, the phone's session is the layout owner of a prepared agent's tab.
async function phoneOrder(runtime: OrcaRuntimeService): Promise<string[]> {
  const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
  return listed.tabGroups?.[0]?.tabOrder ?? []
}

describe('a prepared agent tab published to a headless phone session', () => {
  it('lands before Setup when first admitted, and a later publication keeps the phone user’s order', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const runtime = new OrcaRuntimeService(runtimeStore)
    let spawned = 0
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: `pty-${++spawned}` })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    // Setup is published first, while the agent waits for it.
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    const agent = {
      tabId: 'agent-tab',
      leafId: HEADLESS_SECOND_LEAF_ID,
      placeNewTab: true as const
    }

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, agent)
    expect(await phoneOrder(runtime)).toEqual(['agent-tab', 'host-tab'])

    const groupId = (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabGroups![0]!
      .id
    await runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
      kind: 'reorder',
      tabId: 'agent-tab',
      targetGroupId: groupId,
      tabOrder: ['host-tab', 'agent-tab']
    })
    expect(await phoneOrder(runtime)).toEqual(['host-tab', 'agent-tab'])
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, agent)
    expect(await phoneOrder(runtime)).toEqual(['host-tab', 'agent-tab'])
  })
})
