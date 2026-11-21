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

const CHATS = 1000

afterEach(() => setStructuredAgentSessionHost(null))

function noConversationsHost(): StructuredAgentSessionHost {
  const host = {
    getSessionTabId: () => null,
    deps: { store: { getConversation: () => undefined } }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: titling reads only these members; any other call fails the test.
  return host as unknown as StructuredAgentSessionHost
}

describe('chat tab titles on a workspace with many chats', () => {
  // Guards #46247: each chat's title scanned every saved tab, ~500k reads per frame at 1,000 chats.
  it('reads each saved tab once per projection', async () => {
    setStructuredAgentSessionHost(noConversationsHost())
    let savedTabReads = 0
    const saved: Tab[] = Array.from({ length: CHATS }, (_, index) => {
      const sessionId = `s${index}`
      return {
        id: `agent-session:${sessionId}`,
        get entityId() {
          savedTabReads++
          return sessionId
        },
        groupId: 'g',
        worktreeId: TEST_WORKTREE_ID,
        contentType: 'agent-session',
        label: 'Chat',
        customLabel: index === CHATS - 1 ? 'Renamed' : null,
        color: null,
        sortOrder: index,
        createdAt: 0
      }
    })
    const fixture = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      unifiedTabs: { [TEST_WORKTREE_ID]: saved }
    })
    const runtime = new OrcaRuntimeService(fixture.runtimeStore)
    const snapshot: RuntimeMobileSessionTabsSnapshot = {
      worktree: TEST_WORKTREE_ID,
      publicationEpoch: 'headless',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: saved.map((tab, index) => ({
        type: 'agent-session' as const,
        id: tab.id,
        title: 'Chat',
        sessionId: `s${index}`,
        agent: 'claude' as const,
        isActive: false
      }))
    }
    runtime.storeMobileSessionSnapshot(TEST_WORKTREE_ID, snapshot)

    savedTabReads = 0
    const served = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(served.tabs.find((tab) => tab.id === `agent-session:s${CHATS - 1}`)?.title).toBe(
      'Renamed'
    )
    expect(savedTabReads).toBe(1000)
  })
})
