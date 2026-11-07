import { expect, it, vi } from 'vitest'
import { createChatTabLayoutQueue } from './agent-session-tab-layout-queue'

const open = (sessionId: string) => ({
  worktreeId: 'wt',
  change: { open: { sessionId, agent: 'codex' as const, tabId: `tab-${sessionId}` } }
})

it('settles continuous placement changes and drains the next worktree open', async () => {
  const { getDefaultWorkspaceSession } = await import('../../shared/constants')
  const { withChatTabChanges } = await import('./agent-session/agent-session-tab-layout')
  const { applyCommandToSession } =
    await import('../persistence/terminal-topology/terminal-pane-admission')
  let session = withChatTabChanges('local', getDefaultWorkspaceSession(), 'wt', [
    open('source').change,
    open('B').change,
    open('other').change
  ])!
  const group1 = session.tabGroups!['wt']![0]!.id
  const applyNow = (command: Parameters<typeof applyCommandToSession>[2]) => {
    const result = applyCommandToSession('local', session, command)
    session = result.session ?? session
    return result.value
  }
  expect(
    applyNow({
      type: 'splitGroup',
      workspace: 'wt',
      tabId: 'tab-other',
      besideGroupId: group1,
      direction: 'right'
    }).ok
  ).toBe(true)
  const group2 = session.tabGroups!['wt']!.find((group) => group.id !== group1)!.id
  let attempts = 0
  const written: string[] = []
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const queue = createChatTabLayoutQueue({
    sessionOf: () => session,
    hostIdOf: () => 'local',
    apply: async (command, run) => {
      if (command.type === 'openAgentSessionTab' && command.sessionId === 'child') {
        attempts++
        expect(
          applyNow({
            type: 'moveTab',
            workspace: 'wt',
            tabId: 'tab-source',
            toGroupId: command.groupId === group1 ? group2 : group1,
            index: 0
          }).ok
        ).toBe(true)
      }
      const admitted = run?.admit([session]) !== false
      // Let the uncapped regression fail without leaving its asynchronous loop running.
      if (command.type === 'openAgentSessionTab' && command.sessionId === 'child' && attempts > 4) {
        throw new Error('placement attempts did not settle')
      }
      if (!admitted) {
        return { ok: false, code: 'tab_not_found' }
      }
      const result = applyNow(command)
      if (result.ok && command.type === 'openAgentSessionTab') {
        written.push(command.sessionId)
      }
      return result
    }
  })
  try {
    queue([
      {
        worktreeId: 'wt',
        change: {
          open: {
            sessionId: 'child',
            agent: 'codex',
            tabId: 'tab-child',
            placement: { afterTabId: 'agent-session:source' }
          }
        },
        eligible: () => true
      }
    ])
    await queue([{ ...open('next'), worktreeId: 'next-worktree' }])
    expect(attempts).toBe(4)
    expect(written).toEqual(['next'])
    expect(session.unifiedTabs?.['next-worktree']?.map((tab) => tab.entityId)).toEqual(['next'])
    expect(queue.pendingOpens()).toEqual([])
  } finally {
    warn.mockRestore()
  }
})

it('checks admission inside the actual profile queue before replacement close effects, and does not freeze later writes', async () => {
  const { fixture } =
    await import('../persistence/loading-store/profile-state-delayed-authority-fixture')
  const { applyWindowLayoutCommand } = await import('./terminal/layout/runtime-layout-apply')
  const { store, authority } = await fixture()
  const workspace = 'chat-inner-queue'
  const opened = await store.applyLayoutCommand({
    type: 'openAgentSessionTab',
    workspace,
    sessionId: 'session-a',
    agent: 'codex',
    tabId: 'agent-chat-tab-v1-old'
  })
  expect(opened.ok).toBe(true)
  const gate = authority.pause()
  const holding = store.runDurableMutation(() => {
    store.updateSettings({ theme: 'dark' })
    return { value: undefined }
  })
  await gate.started.promise
  let current = true
  const effects = vi.fn()
  const entered = Promise.withResolvers<void>(),
    settled = Promise.withResolvers<void>()
  const queue = createChatTabLayoutQueue({
    sessionOf: () => store.getWorkspaceSession(),
    hostIdOf: () => 'local',
    apply: async (command, run) => {
      entered.resolve()
      try {
        return await applyWindowLayoutCommand(store, () => ['local'], command, undefined, {
          ...run,
          onEffects: effects
        })
      } finally {
        settled.resolve()
      }
    }
  })
  queue(() => [
    {
      worktreeId: workspace,
      change: { close: 'session-a', tabId: 'agent-chat-tab-v1-old' },
      eligible: () => current
    }
  ])
  await entered.promise
  current = false
  const before = authority.captures.length
  gate.finish.resolve()
  await holding
  await settled.promise
  expect(effects).not.toHaveBeenCalled()
  expect(authority.captures.length).toBe(before)
  expect(store.getWorkspaceSession().unifiedTabs?.[workspace]?.map((tab) => tab.id)).toEqual([
    'agent-chat-tab-v1-old'
  ])
  expect(
    await applyWindowLayoutCommand(
      store,
      () => ['local'],
      { type: 'closeTabs', workspace, tabIds: ['agent-chat-tab-v1-old'], force: true },
      undefined,
      { admit: () => true }
    )
  ).toMatchObject({ ok: true })
  expect(store.getWorkspaceSession().unifiedTabs?.[workspace] ?? []).toEqual([])
})

it('refuses a captured close when another actual holder now uses that id for a different session', async () => {
  const { fixture } =
    await import('../persistence/loading-store/profile-state-delayed-authority-fixture')
  const { withChatTabChanges } = await import('./agent-session/agent-session-tab-layout')
  const { getDefaultWorkspaceSession } = await import('../../shared/constants')
  const { applyWindowLayoutCommand } = await import('./terminal/layout/runtime-layout-apply')
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
