import { expect, it, vi } from 'vitest'
import { seedStructuredConversationTabPermissions } from './structured-conversation-tab-permission-seed'
import { record } from '../native-chat/agent-session-wire/structured-agent-session-restart-resume-test-harness'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'

const saved = record({ chain: [] })
const snapshot: RuntimeMobileSessionTabsSnapshot = {
  worktree: saved.location.workspaceId,
  publicationEpoch: 'p',
  snapshotVersion: 1,
  activeGroupId: null,
  activeTabId: 'chat',
  activeTabType: 'agent-session',
  tabs: [
    {
      type: 'agent-session',
      id: 'chat',
      title: 'Chat',
      sessionId: saved.sessionId,
      agent: 'codex',
      isActive: true
    }
  ]
}

it('publishes current host intent and its fence with the first tab, without storing another copy', () => {
  saved.options = { permissionMode: 'auto' }
  const seeded = seedStructuredConversationTabPermissions(snapshot, () => saved)
  expect(seeded.tabs[0]).toMatchObject({
    permissionSeed: { mode: 'auto', fence: saved.lease.runtimeFence }
  })
  expect(snapshot.tabs[0]).not.toHaveProperty('permissionSeed')
  saved.options = { permissionMode: 'ask' }
  expect(seedStructuredConversationTabPermissions(snapshot, () => saved).tabs[0]).toMatchObject({
    permissionSeed: { mode: 'ask' }
  })
})

it('does not seed a missing record, another workspace, or an unsupported agent', () => {
  expect(
    seedStructuredConversationTabPermissions(snapshot, () => undefined).tabs[0]
  ).not.toHaveProperty('permissionSeed')
  expect(
    seedStructuredConversationTabPermissions({ ...snapshot, worktree: 'other' }, () => saved)
      .tabs[0]
  ).not.toHaveProperty('permissionSeed')
  expect(
    seedStructuredConversationTabPermissions(snapshot, () => ({ ...saved, provider: 'other' }))
      .tabs[0]
  ).not.toHaveProperty('permissionSeed')
})

it('carries fixed derived intent on legacy tab seeds without changing the record', () => {
  const legacy = { ...saved, options: {} }
  const fact = { mode: 'ask', fence: 7, revision: 0 } as const
  const seeded = seedStructuredConversationTabPermissions(
    snapshot,
    () => legacy,
    () => fact
  )
  expect(seeded.tabs[0]).toHaveProperty('permissionSeed', fact)
  expect(legacy.options).toEqual({})
  expect(snapshot.tabs[0]).not.toHaveProperty('permissionSeed')
})

it('lists the tab unseeded when the permission read throws, and keeps seeding the others', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const other = { ...saved, sessionId: 'other-session', options: { permissionMode: 'bypass' } }
  const twoTabs = {
    ...snapshot,
    tabs: [...snapshot.tabs, { ...snapshot.tabs[0], id: 'other', sessionId: other.sessionId }]
  }
  const seeded = seedStructuredConversationTabPermissions(
    twoTabs,
    (id) => (id === other.sessionId ? other : saved),
    (id) => {
      if (id === saved.sessionId) {
        throw new TypeError('store.permissionRevision is not a function')
      }
      return undefined
    }
  )
  expect(seeded.tabs.map((tab) => tab.id)).toEqual(['chat', 'other'])
  expect(seeded.tabs[0]).not.toHaveProperty('permissionSeed')
  expect(seeded.tabs[1]).toMatchObject({ permissionSeed: { mode: 'bypass' } })
  expect(warn).toHaveBeenCalledOnce()
  warn.mockRestore()
})

it('does not read the permission fact for a record from another workspace', () => {
  const factFor = vi.fn(() => undefined)
  seedStructuredConversationTabPermissions({ ...snapshot, worktree: 'other' }, () => saved, factFor)
  expect(factFor).not.toHaveBeenCalled()
})
