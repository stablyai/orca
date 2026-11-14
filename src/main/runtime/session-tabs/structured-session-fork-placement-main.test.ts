import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { fixture } from '../../persistence/loading-store/profile-writing/profile-state-delayed-authority-fixture'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

it.each(['current', 'superseded', 'refused'] as const)(
  'publishes a queued source move only while admitted: %s',
  async (outcome) => {
    const { store, authority } = await fixture()
    const workspace = 'fork-delayed-placement'
    for (const sessionId of ['source', 'B', 'active']) {
      expect(
        await store.applyLayoutCommand({
          type: 'openAgentSessionTab',
          workspace,
          sessionId,
          agent: 'codex',
          tabId: `structured-agent-session-${sessionId}`
        })
      ).toMatchObject({ ok: true })
    }
    const group1 = store.getWorkspaceSession().tabGroups?.[workspace]?.[0]?.id
    if (!group1) {
      throw new Error('expected initial group')
    }
    expect(
      await store.applyLayoutCommand({
        type: 'splitGroup',
        workspace,
        tabId: 'structured-agent-session-active',
        besideGroupId: group1,
        direction: 'right'
      })
    ).toMatchObject({ ok: true })
    const group2 = store
      .getWorkspaceSession()
      .tabGroups?.[workspace]?.find((group) => group.id !== group1)?.id
    if (!group2) {
      throw new Error('expected second group')
    }
    const runtime = new OrcaRuntimeService(store)
    for (const sessionId of ['source', 'B', 'active']) {
      runtime.projectStructuredAgentSessionTab({
        workspaceId: workspace,
        sessionId,
        agent: 'codex',
        activate: false
      })
    }
    const applying = Promise.withResolvers<void>()
    const apply = store.applyLayoutCommand.bind(store)
    vi.spyOn(store, 'applyLayoutCommand').mockImplementation((command, hosts, run) => {
      if (command.type === 'openAgentSessionTab' && command.sessionId === 'child') {
        applying.resolve()
        if (outcome === 'refused') {
          return Promise.resolve({ ok: false, code: 'group_not_found' })
        }
      }
      return apply(command, hosts, run)
    })
    const gate = authority.pause()
    const holding = store.runDurableMutation(() => {
      store.updateSettings({ theme: 'dark' })
      return { value: undefined }
    })
    await gate.started.promise
    const moving = store.applyLayoutCommand({
      type: 'moveTab',
      workspace,
      tabId: 'structured-agent-session-source',
      toGroupId: group2,
      index: 0
    })
    let current = true
    const publishing = runtime
      .publishStructuredAgentSessionTab({
        workspaceId: workspace,
        sessionId: 'child',
        agent: 'codex',
        activate: false,
        placement: { afterTabId: 'agent-session:source' },
        workspaceAuthority: {
          check() {},
          current: () => current,
          committed() {},
          saving() {}
        }
      })
      .then(
        () => true,
        () => false
      )
    try {
      await applying.promise
      expect(store.getWorkspaceSession().tabGroups?.[workspace]?.[0]?.tabOrder).toEqual([
        'structured-agent-session-source',
        'structured-agent-session-B'
      ])
      if (outcome === 'superseded') {
        current = false
      }
    } finally {
      gate.finish.resolve()
    }
    await holding
    expect(await moving).toMatchObject({ ok: true })
    if (outcome !== 'current') {
      expect(await publishing).toBe(false)
      expect(
        store.getWorkspaceSession().unifiedTabs?.[workspace]?.map((tab) => tab.entityId)
      ).toEqual(['B', 'source', 'active'])
      expect(
        runtime.mobileSessionTabsByWorktree
          .get(workspace)
          ?.tabs.map((tab) => tab.id)
          .sort()
      ).toEqual(['agent-session:B', 'agent-session:active', 'agent-session:source'])
      return
    }
    expect(await publishing).toBe(true)
    expect(
      store.getWorkspaceSession().tabGroups?.[workspace]?.map((group) => group.tabOrder)
    ).toEqual([
      ['structured-agent-session-B'],
      [
        'structured-agent-session-source',
        'structured-agent-session-child',
        'structured-agent-session-active'
      ]
    ])
    expect(
      runtime.mobileSessionTabsByWorktree.get(workspace)?.tabGroups?.map((group) => group.tabOrder)
    ).toEqual([
      ['agent-session:B'],
      ['agent-session:source', 'agent-session:child', 'agent-session:active']
    ])
  }
)
