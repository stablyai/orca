import { expect, it, vi } from 'vitest'
import { createChatTabLayoutQueue } from './agent-session-tab-layout-queue'

it('refuses a captured close when another actual holder now uses that id for a different session', async () => {
  const { fixture } =
    await import('../../persistence/loading-store/profile-writing/profile-state-delayed-authority-fixture')
  const { withChatTabChanges } = await import('./agent-session-tab-layout')
  const { getDefaultWorkspaceSession } = await import('../../../shared/constants')
  const { applyWindowLayoutCommand } = await import('../terminal/layout/runtime-layout-apply')
  const { store } = await fixture()
  const workspace = 'all-holders'
  for (const [hostId, sessionId] of [
    ['local', 'captured'],
    ['ssh:other', 'replacement']
  ] as const) {
    const session = withChatTabChanges(hostId, getDefaultWorkspaceSession(), workspace, [
      { open: { sessionId, agent: 'codex', tabId: 'same-tab' } }
    ])
    if (!session) {
      throw new Error('expected saved tab')
    }
    store.setWorkspaceSession(session, hostId)
  }
  await store.flushPendingOrThrowAsync()
  const effects = vi.fn()
  const settled = Promise.withResolvers<void>()
  let reply: unknown
  const queue = createChatTabLayoutQueue({
    sessionOf: () => store.getWorkspaceSession('local'),
    hostIdOf: () => 'local',
    apply: async (command, run) => {
      try {
        const result = await applyWindowLayoutCommand(
          store,
          () => ['local', 'ssh:other'],
          command,
          undefined,
          { ...run, onEffects: effects }
        )
        reply = result
        return result
      } finally {
        settled.resolve()
      }
    }
  })
  queue([{ worktreeId: workspace, change: { close: 'captured', tabId: 'same-tab' } }])
  await settled.promise
  expect(reply).toMatchObject({ ok: false })
  expect(effects).not.toHaveBeenCalled()
  expect(store.getWorkspaceSession('local').unifiedTabs?.[workspace]?.[0]?.entityId).toBe(
    'captured'
  )
  expect(store.getWorkspaceSession('ssh:other').unifiedTabs?.[workspace]?.[0]?.entityId).toBe(
    'replacement'
  )
})
