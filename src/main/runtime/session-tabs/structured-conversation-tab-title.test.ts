import { expect, it } from 'vitest'
import {
  retitleStructuredConversationTabs,
  titleStructuredConversationTabs
} from './structured-conversation-tab-title'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'

const snapshot: RuntimeMobileSessionTabsSnapshot = {
  worktree: 'workspace',
  publicationEpoch: 'epoch',
  snapshotVersion: 3,
  activeGroupId: null,
  activeTabId: null,
  activeTabType: null,
  tabs: [
    {
      type: 'agent-session',
      id: 'tab',
      title: 'Annotate fork',
      sessionId: 'fork',
      agent: 'codex',
      isActive: true
    }
  ]
}

it("marks a forked chat's phone tab and titles it with the shown name", () => {
  const titled = titleStructuredConversationTabs(
    snapshot,
    () => 'Annotate',
    (id) => id === 'fork'
  )
  expect(titled.tabs[0]).toMatchObject({ title: 'Annotate', forked: true })
})

it('republishes a fork mark that appears under an unchanged title', () => {
  const next = retitleStructuredConversationTabs(
    snapshot,
    new Map([['fork', 'Annotate fork']]),
    () => true
  )
  expect(next?.snapshotVersion).toBe(4)
  expect(next?.tabs[0]).toMatchObject({ title: 'Annotate fork', forked: true })
  expect(
    retitleStructuredConversationTabs(next!, new Map([['fork', 'Annotate fork']]), () => true)
  ).toBeNull()
})
