import { describe, expect, it } from 'vitest'
import '../../terminal/layout/bind-first-pane.test-fixture'
import '../../terminal/layout/profile-session-store.test-fixture'
import '../../construction/test-context/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import '../../orca-runtime-test-mocks/setup.spec'
import {
  TEST_WORKTREE_ID,
  store
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'

const OTHER_WORKTREE_ID = `${TEST_WORKTREE_ID}-empty`

async function publishOneWorkspace(runtime: OrcaRuntimeService): Promise<void> {
  await runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [
      {
        worktree: TEST_WORKTREE_ID,
        publicationEpoch: 'renderer-1',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }
    ]
  })
}

describe('session tabs for a workspace no window published', () => {
  it('answers empty once the desktop window has closed, since nothing will publish', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    await publishOneWorkspace(runtime)
    runtime.markGraphUnavailable(1)

    const listed = await runtime.listMobileSessionTabs(`id:${OTHER_WORKTREE_ID}`)

    expect(listed.tabs).toEqual([])
    expect(listed.publicationEpoch).not.toBe('none')
  })
})
