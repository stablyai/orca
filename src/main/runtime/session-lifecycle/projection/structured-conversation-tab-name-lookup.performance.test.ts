import { afterEach, describe, expect, it } from 'vitest'
import '../../construction/test-context/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

afterEach(() => setStructuredAgentSessionHost(null))

function noConversationsHost(): StructuredAgentSessionHost {
  const host = {
    getSessionTabId: () => null,
    deps: { store: { getConversation: () => undefined } }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: titling reads only these members; any other call fails the test.
  return host as unknown as StructuredAgentSessionHost
}

/** Saves `saved` tabs (every other one a chat, the rest files), shows the first `shown` chats, and counts saved-row visits in one listing. */
async function savedRowVisitsForOneListing(saved: number, shown: number) {
  let visits = 0
  const tabs: Tab[] = Array.from({ length: saved }, (_, index) => {
    const isChat = index % 2 === 1
    const entityId = isChat ? `s${(index - 1) / 2}` : `/file-${index}`
    return {
      id: isChat ? `agent-session:${entityId}` : entityId,
      entityId,
      groupId: 'g',
      worktreeId: TEST_WORKTREE_ID,
      get contentType() {
        visits++
        return isChat ? ('agent-session' as const) : ('editor' as const)
      },
      label: 'Tab',
      customLabel: index === shown * 2 - 1 ? 'Renamed' : null,
      color: null,
      sortOrder: index,
      createdAt: 0
    }
  })
  const fixture = makeRuntimeStoreWithWorkspaceSession({
    ...getDefaultWorkspaceSession(),
    unifiedTabs: { [TEST_WORKTREE_ID]: tabs }
  })
  const runtime = new OrcaRuntimeService(fixture.runtimeStore)
  const snapshot: RuntimeMobileSessionTabsSnapshot = {
    worktree: TEST_WORKTREE_ID,
    publicationEpoch: 'headless',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: Array.from({ length: shown }, (_, index) => ({
      type: 'agent-session' as const,
      id: `agent-session:s${index}`,
      title: 'Chat',
      sessionId: `s${index}`,
      agent: 'claude' as const,
      isActive: false
    }))
  }
  runtime.storeMobileSessionSnapshot(TEST_WORKTREE_ID, snapshot)
  visits = 0
  const served = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
  const renamed = served.tabs.find((tab) => tab.id === `agent-session:s${shown - 1}`)
  return { visits, renamedTitle: renamed?.title }
}

// Guards #46247: each chat's title scanned the saved tabs from the start, ~1M row visits per listing at 1,000 chats.
describe('chat tab titles on a workspace with many saved tabs', () => {
  it('visits the saved tabs in one pass after the first chat', async () => {
    setStructuredAgentSessionHost(noConversationsHost())
    expect(await savedRowVisitsForOneListing(2000, 1000)).toEqual({
      visits: 2002,
      renamedTitle: 'Renamed'
    })
  })

  it('stops at the last chat it needs', async () => {
    setStructuredAgentSessionHost(noConversationsHost())
    expect(await savedRowVisitsForOneListing(2000, 3)).toEqual({
      visits: 8,
      renamedTitle: 'Renamed'
    })
  })
})
