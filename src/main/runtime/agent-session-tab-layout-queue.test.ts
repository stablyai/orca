import { afterEach, expect, it, vi } from 'vitest'
import { createChatTabLayoutQueue } from './agent-session-tab-layout-queue'
import type { ChatTabLayoutCommand } from './agent-session/agent-session-tab-layout'

const layoutOwner = vi.hoisted(() => ({ main: false }))
vi.mock('../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.main
  }
}))
afterEach(() => {
  layoutOwner.main = false
})

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

it.each([10, 100])(
  'releases %i concrete descriptors across success/refusal/throw and permits a real next write',
  async (p) => {
    const { fixture } =
      await import('../persistence/loading-store/profile-state-delayed-authority-fixture')
    const { applyWindowLayoutCommand } = await import('./terminal/layout/runtime-layout-apply')
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

it.each(['accepted', 'refused'] as const)(
  "closes a workspace's adjacent chat tabs in one command, or each alone when that one is %s",
  async (verdict) => {
    const { withChatTabChanges } = await import('./agent-session/agent-session-tab-layout')
    const { getDefaultWorkspaceSession } = await import('../../shared/constants')
    const ids = ['a', 'b', 'c']
    const session = withChatTabChanges(
      'local',
      getDefaultWorkspaceSession(),
      'wt',
      ids.map((id) => open(id)).map(({ change }) => change)
    )!
    const commands: string[][] = []
    const queue = createChatTabLayoutQueue({
      sessionOf: () => session,
      hostIdOf: () => 'local',
      apply: async (command: ChatTabLayoutCommand) => {
        const tabIds = command.type === 'closeTabs' ? [...command.tabIds] : []
        commands.push(tabIds)
        return verdict === 'refused' && tabIds.length > 1
          ? { ok: false, code: 'host_not_owned' }
          : { ok: true, result: {} }
      }
    })
    await queue(ids.map((id) => ({ worktreeId: 'wt', change: { close: id, tabId: `tab-${id}` } })))
    expect(commands).toEqual(
      verdict === 'accepted'
        ? [['tab-a', 'tab-b', 'tab-c']]
        : [['tab-a', 'tab-b', 'tab-c'], ['tab-a'], ['tab-b'], ['tab-c']]
    )
  }
)

/** Chat A in four tabs, chat C and an editor; a4, then a2 and a3, each alone in a split group on
 *  either side of C's group, whose selection and recent tabs are saved. */
async function savedDuplicateChats(workspace: string) {
  const { fixture } =
    await import('../persistence/loading-store/profile-state-delayed-authority-fixture')
  const { store } = await fixture()
  const chat = (sessionId: string, tabId: string) =>
    store.applyLayoutCommand({
      type: 'openAgentSessionTab',
      workspace,
      sessionId,
      agent: 'codex',
      tabId
    })
  await chat('A', 'a1')
  await chat('C', 'c')
  await store.applyLayoutCommand({
    type: 'openEditorTab',
    workspace,
    tabId: 'e',
    fileId: '/w/e.ts',
    contentType: 'editor',
    file: { filePath: '/w/e.ts', relativePath: 'e.ts', language: 'typescript' }
  })
  await chat('A', 'a2')
  await chat('A', 'a3')
  await chat('A', 'a4')
  const groupOf = (tabId: string) =>
    store
      .getWorkspaceSession()
      .tabGroups?.[workspace]?.find((group) => group.tabOrder.includes(tabId))?.id ?? 'no-group'
  for (const [tabId, beside, direction] of [
    ['a2', 'a1', 'right'],
    ['a3', 'a2', 'down'],
    ['a4', 'a1', 'left']
  ] as const) {
    await store.applyLayoutCommand({
      type: 'splitGroup',
      workspace,
      tabId,
      besideGroupId: groupOf(beside),
      direction
    })
  }
  const session = store.getWorkspaceSession()
  const groups = session.tabGroups?.[workspace] ?? []
  expect(groups.map((group) => group.tabOrder).toSorted()).toEqual([
    ['a1', 'c', 'e'],
    ['a2'],
    ['a3'],
    ['a4']
  ])
  return {
    ...session,
    tabGroups: {
      ...session.tabGroups,
      [workspace]: groups.map((group) =>
        group.tabOrder.includes('c')
          ? { ...group, activeTabId: 'a1', recentTabIds: ['e', 'c', 'a1'] }
          : group
      )
    }
  }
}

it.each(
  [true, false].flatMap((main) =>
    [
      { closes: ['a1', 'a2'], left: ['c', 'e', 'a3', 'a4'] },
      // A close names the first A tab left, or closes nothing: a2 first finds a1 there.
      { closes: ['a2', 'a1'], left: ['c', 'e', 'a2', 'a3', 'a4'] },
      { closes: ['a1', 'a1'], left: ['c', 'e', 'a2', 'a3', 'a4'] },
      { closes: ['a1', 'a2', 'a3'], left: ['c', 'e', 'a4'] },
      // Empties groups on both sides of C's group in the tree.
      { closes: ['a1', 'a2', 'a3', 'a4'], left: ['c', 'e'] }
    ].map((row) => ({ ...row, main }))
  )
)(
  'closes $closes of one chat together exactly as one at a time would, keeping C and the editor (main owner: $main)',
  async ({ closes, left, main }) => {
    layoutOwner.main = main
    const { fixture } =
      await import('../persistence/loading-store/profile-state-delayed-authority-fixture')
    const { applyWindowLayoutCommand } = await import('./terminal/layout/runtime-layout-apply')
    const workspace = 'duplicate-chat-tabs'
    const saved = await savedDuplicateChats(workspace)
    const changes = closes.map((tabId) => ({
      worktreeId: workspace,
      change: { close: 'A', tabId }
    }))
    const closing = async (together: boolean) => {
      const { store } = await fixture()
      store.setWorkspaceSession(structuredClone(saved))
      await store.flushPendingOrThrowAsync()
      const commands: string[][] = []
      const queue = createChatTabLayoutQueue({
        sessionOf: () => store.getWorkspaceSession(),
        hostIdOf: () => 'local',
        apply: (command, run) => {
          commands.push(command.type === 'closeTabs' ? [...command.tabIds] : [])
          return applyWindowLayoutCommand(store, () => ['local'], command, undefined, run)
        }
      })
      if (together) {
        await queue(changes)
      } else {
        for (const change of changes) {
          await queue([change])
        }
      }
      const session = store.getWorkspaceSession()
      return {
        commands,
        tabs: session.unifiedTabs?.[workspace],
        groups: session.tabGroups?.[workspace],
        tree: session.tabGroupLayouts?.[workspace]
      }
    }
    const one = await closing(false)
    const together = await closing(true)
    expect(together.commands).toHaveLength(1)
    expect(together.commands[0]).toEqual(one.commands.flat())
    expect({ ...together, commands: [] }).toEqual({ ...one, commands: [] })
    expect(together.tabs?.map((tab) => tab.id).toSorted()).toEqual(left.toSorted())
    // The first group keeps C and the editor, its selection following the close in both.
    expect(together.groups?.find((group) => group.tabOrder.includes('c'))).toMatchObject({
      tabOrder: ['c', 'e'],
      recentTabIds: ['e', 'c']
    })
  }
)
