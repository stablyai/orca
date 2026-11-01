import { expect, it, vi } from 'vitest'
import { createChatTabLayoutQueue } from './agent-session-tab-layout-queue'
import type { ChatTabLayoutCommand } from './agent-session/agent-session-tab-layout'

const open = (sessionId: string) => ({
  worktreeId: 'wt',
  change: { open: { sessionId, agent: 'codex' as const, tabId: `tab-${sessionId}` } }
})

it('asks no host of a worktree with no saved session, and goes on past a change that fails', async () => {
  const applied: string[] = []
  const hostIdOf = vi.fn((): never => {
    throw new Error('folder_workspace_not_found')
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const queue = createChatTabLayoutQueue({
    sessionOf: () => null,
    hostIdOf,
    apply: async (command: ChatTabLayoutCommand) => {
      if (command.type === 'openAgentSessionTab' && command.sessionId === 'a') {
        throw new Error('layout_store_unavailable')
      }
      applied.push(command.type === 'openAgentSessionTab' ? command.sessionId : 'close')
      return { ok: true, result: {} }
    }
  })

  queue([open('a')])
  queue([open('b')])
  await vi.waitFor(() => expect(applied).toEqual(['b']))

  expect(hostIdOf).not.toHaveBeenCalled()
  expect(warn).toHaveBeenCalledOnce()
  warn.mockRestore()
})

it('goes on past a batch whose changes cannot be read', async () => {
  const applied: string[] = []
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const queue = createChatTabLayoutQueue({
    sessionOf: () => null,
    hostIdOf: () => 'local',
    apply: async (command: ChatTabLayoutCommand) => {
      applied.push(command.type === 'openAgentSessionTab' ? command.sessionId : 'close')
      return { ok: true, result: {} }
    }
  })

  queue(() => {
    throw new Error('session store unreadable')
  })
  queue([open('b')])
  await vi.waitFor(() => expect(applied).toEqual(['b']))

  expect(warn).toHaveBeenCalledOnce()
  warn.mockRestore()
})

it('checks admission inside the actual profile queue before replacement close effects, and does not freeze later writes', async () => {
  const { fixture } =
    await import('../persistence/loading-store/profile-state-delayed-authority-fixture')
  const { applyWindowLayoutCommand } = await import('./runtime-layout-apply')
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

it('closes the captured row that an earlier queued open has not saved yet; missing identity never means wildcard', async () => {
  const { fixture } =
    await import('../persistence/loading-store/profile-state-delayed-authority-fixture')
  const { applyWindowLayoutCommand } = await import('./runtime-layout-apply')
  const { store, authority } = await fixture()
  const workspace = 'queued-captured-close'
  const gate = authority.pause()
  const holding = store.runDurableMutation(() => {
    store.updateSettings({ theme: 'dark' })
    return { value: undefined }
  })
  await gate.started.promise
  let applies = 0
  let applied: Promise<unknown> = Promise.resolve()
  const queue = createChatTabLayoutQueue({
    sessionOf: () => store.getWorkspaceSession(),
    hostIdOf: () => 'local',
    apply: (command, run) => {
      applies++
      const result = applyWindowLayoutCommand(store, () => ['local'], command, undefined, run)
      applied = result
      return result
    }
  })
  expect(store.getWorkspaceSession().unifiedTabs?.[workspace]).toBeUndefined()
  queue([
    {
      worktreeId: workspace,
      change: { open: { sessionId: 'a', agent: 'codex', tabId: 'agent-chat-tab-v1-captured' } }
    }
  ])
  expect(queue.pendingOpens()).toHaveLength(1)
  queue(() => [
    { worktreeId: workspace, change: { close: 'a', tabId: 'agent-chat-tab-v1-captured' } }
  ])
  gate.finish.resolve()
  await holding
  await vi.waitFor(() => expect(applies).toBe(2))
  await applied
  expect(store.getWorkspaceSession().unifiedTabs?.[workspace] ?? []).toEqual([])
  await store.applyLayoutCommand({
    type: 'openAgentSessionTab',
    workspace,
    sessionId: 'a',
    agent: 'codex',
    tabId: 'agent-chat-tab-v1-next'
  })
  queue(() => [{ worktreeId: workspace, change: { close: 'a' } }])
  queue(() => [
    { worktreeId: workspace, change: { open: { sessionId: 'b', agent: 'codex', tabId: 'tab-b' } } }
  ])
  await vi.waitFor(() => expect(applies).toBe(3))
  await applied
  expect(store.getWorkspaceSession().unifiedTabs?.[workspace]?.map((tab) => tab.entityId)).toEqual([
    'a',
    'b'
  ])
})

it('refuses a captured close when another actual holder now uses that id for a different session', async () => {
  const { fixture } =
    await import('../persistence/loading-store/profile-state-delayed-authority-fixture')
  const { withChatTabChanges } = await import('./agent-session/agent-session-tab-layout')
  const { getDefaultWorkspaceSession } = await import('../../shared/constants')
  const { applyWindowLayoutCommand } = await import('./runtime-layout-apply')
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

it.each([10, 100])(
  'releases %i concrete descriptors across success/refusal/throw and permits a real next write',
  async (p) => {
    const { fixture } =
      await import('../persistence/loading-store/profile-state-delayed-authority-fixture')
    const { applyWindowLayoutCommand } = await import('./runtime-layout-apply')
    const { store, authority } = await fixture()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const mode of ['success', 'superseded', 'eligibility-error', 'apply-error'] as const) {
      const workspace = `pending-${mode}`,
        gate = authority.pause()
      const holding = store.runDurableMutation(() => {
        store.updateSettings({ theme: 'dark' })
        return { value: undefined }
      })
      await gate.started.promise
      const done = Promise.withResolvers<void>()
      let released = false
      const queue = createChatTabLayoutQueue({
        sessionOf: () => store.getWorkspaceSession(),
        hostIdOf: () => 'local',
        apply: async (command, run) => {
          try {
            if (
              mode === 'apply-error' &&
              command.type === 'openAgentSessionTab' &&
              command.sessionId === 's1'
            ) {
              throw new Error('apply failed')
            }
            return await applyWindowLayoutCommand(store, () => ['local'], command, undefined, run)
          } finally {
            if (command.type === 'openAgentSessionTab' && command.sessionId === 'valid') {
              done.resolve()
            }
          }
        }
      })
      try {
        queue(
          Array.from({ length: p }, (_, i) => ({
            worktreeId: workspace,
            change: { open: { sessionId: `s${i}`, tabId: `tab-${i}`, agent: 'codex' } },
            eligible: () => {
              if (released && mode === 'eligibility-error') {
                throw new Error('eligibility failed')
              }
              return !released || mode !== 'superseded'
            }
          }))
        )
        expect(queue.pendingOpens()).toHaveLength(p)
        const captured = queue.pendingOpens()
        released = true
        gate.finish.resolve()
        await holding
        queue([
          {
            worktreeId: workspace,
            change: { open: { sessionId: 'valid', tabId: 'valid', agent: 'codex' } }
          }
        ])
        await done.promise
        await vi.waitFor(() => expect(queue.pendingOpens()).toHaveLength(0))
        expect(captured).toHaveLength(p)
        const rows = store.getWorkspaceSession().unifiedTabs?.[workspace] ?? []
        expect(rows.map((row) => row.entityId)).toContain('valid')
        expect(rows).toHaveLength(mode === 'success' ? p + 1 : mode === 'apply-error' ? p : 1)
      } finally {
        gate.finish.resolve()
        await holding
      }
    }
    warn.mockRestore()
  }
)
