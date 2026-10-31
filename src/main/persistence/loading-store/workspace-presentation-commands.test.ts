import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../../runtime/runtime-rpc'
import { RuntimeClient } from '../../../cli/runtime-client'
import { dispatch } from '../../../cli/dispatch'
import { applyWindowLayoutCommand } from '../../runtime/runtime-layout-apply'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { Tab } from '../../../shared/tab-types'
import {
  workspacePresentationKey,
  sourceBaseline,
  type WorkspacePresentation
} from '../../../shared/workspace-presentation'
import { composeWorkspacePresentation } from '../../../shared/workspace-presentation-reconcile'
import {
  emptyTerminalSessionProfile,
  openTopologyStoreWithAuthority,
  openTopologyStore
} from '../terminal-topology/terminal-topology-profile-fixture'
import type { Store } from './store'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))
const O = 'repo-local::C:\\repo'
const D = 'repo-local::C:/repo'
const key = workspacePresentationKey('main', { hostId: 'local', workspaceId: D })
const split = {
  type: 'split' as const,
  direction: 'horizontal' as const,
  ratio: 0.37,
  first: { type: 'leaf' as const, groupId: 'left' },
  second: { type: 'leaf' as const, groupId: 'right' }
}
const directories: string[] = []
const stores: Store[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.freezeWritesAsync()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})
function fixture() {
  const tab = (workspace: string, id: string, groupId: string): Tab => ({
    id: `structured-agent-session-${id}`,
    entityId: id,
    groupId,
    worktreeId: workspace,
    executionHostId: 'local',
    contentType: 'agent-session',
    agentSessionAgent: id === 'chat1' ? 'codex' : 'claude',
    label: id,
    customLabel: id === 'chat1' ? 'Saved name' : null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  })
  const one = tab(O, 'chat1', 'left'),
    two = tab(D, 'chat2', 'right')
  const group = (workspace: string, tab: Tab) => ({
    id: tab.groupId,
    worktreeId: workspace,
    activeTabId: tab.id,
    tabOrder: [tab.id]
  })
  const session = {
    ...getDefaultWorkspaceSession(),
    unifiedTabs: { [O]: [one], [D]: [two] },
    tabGroups: { [O]: [group(O, one)], [D]: [group(D, two)] },
    tabGroupLayouts: { [O]: split.first, [D]: split.second },
    activeGroupIdByWorktree: { [O]: 'left', [D]: 'right' }
  }
  const baseline = [O, D].map((workspaceId) =>
    sourceBaseline(session, { hostId: 'local', workspaceId })
  )
  const document: WorkspacePresentation = {
    schemaVersion: 1,
    owner: 'main',
    anchor: { hostId: 'local', workspaceId: D },
    displayWorkspaceId: D,
    tabs: baseline.flatMap((source) => source.tabs),
    groups: baseline
      .flatMap((source) => source.groups)
      .map((group) => ({ ...group, worktreeId: D })),
    layout: split,
    activeGroupId: 'left',
    baseline
  }
  return { session, document }
}
async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-presentation-'))
  directories.push(directory)
  const result = await openTopologyStoreWithAuthority(directory, emptyTerminalSessionProfile())
  stores.push(result.store)
  const { session, document } = fixture()
  await result.store.commitWorkspacePresentation({
    mode: 'replace',
    sessions: [{ state: session }],
    presentations: { [key]: document }
  })
  return { ...result, directory, session, document }
}
function view(store: Store) {
  const document = store.getWorkspacePresentations()[key]!
  const session = store.getWorkspaceSession()
  return composeWorkspacePresentation(
    document,
    document.baseline.map((baseline) => ({
      baseline,
      tabs: session.unifiedTabs?.[baseline.source.workspaceId] ?? []
    }))
  )
}
vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
describe('independent main selected group creation', () => {
  it('puts a newly created terminal in the recovered group the user selected', async () => {
    const { store, directory } = await setup()
    const reply = await applyWindowLayoutCommand(store, () => ['local'], {
      type: 'createTerminalTab',
      workspace: D,
      groupId: 'left',
      tabId: 'terminal',
      leafId: '11111111-1111-4111-8111-111111111111'
    })
    expect(reply.ok).toBe(true)
    expect(view(store).activeGroupId).toBe('left')
    expect(view(store).groups.find((group) => group.id === 'left')?.activeTabId).toBe('terminal')
    expect(store.getWorkspaceSession().unifiedTabs?.[O]?.map((tab) => tab.entityId)).toEqual([
      'chat1'
    ])
    expect(
      store.getWorkspaceSession().unifiedTabs?.[D]?.find((tab) => tab.entityId === 'terminal')
        ?.groupId
    ).toBe('right')
    expect(view(store).tabs.find((tab) => tab.entityId === 'terminal')?.groupId).toBe('left')
    await store.freezeWritesAsync()
    const reopened = await openTopologyStore(directory)
    stores.push(reopened)
    expect(view(reopened).tabs.find((tab) => tab.entityId === 'terminal')?.groupId).toBe('left')
  })

  it('rolls failed left-group creation back atomically and withdraws a failed spawn without undoing newer U', async () => {
    const { store, authority } = await setup()
    const command = {
      type: 'createTerminalTab' as const,
      workspace: D,
      groupId: 'left',
      tabId: 'terminal',
      leafId: '11111111-1111-4111-8111-111111111111'
    }
    const before = store.getWorkspacePresentations()[key]
    authority.failNextWrite()
    await expect(applyWindowLayoutCommand(store, () => ['local'], command)).rejects.toThrow(
      'profile_state_write_failed'
    )
    expect(store.getWorkspacePresentations()[key]).toEqual(before)
    expect(store.getWorkspaceSession().unifiedTabs?.[D]?.map((tab) => tab.entityId)).toEqual([
      'chat2'
    ])
    await expect(store.admitTerminalPane(command)).resolves.toBe('admitted')
    expect(view(store).tabs.find((tab) => tab.entityId === 'terminal')?.groupId).toBe('left')
    await applyWindowLayoutCommand(store, () => ['local'], {
      type: 'setGroupRatios',
      workspace: D,
      ratios: [{ path: '', ratio: 0.61 }]
    })
    await store.withdrawTerminalPane({
      type: 'closePane',
      workspace: D,
      tabId: command.tabId,
      leafId: command.leafId
    })
    expect(view(store).tabs.map((tab) => tab.entityId)).toEqual(['chat1', 'chat2'])
    expect(view(store).layout).toEqual({ ...split, ratio: 0.61 })
    expect(store.getWorkspaceSession().unifiedTabs?.[O]?.map((tab) => tab.entityId)).toEqual([
      'chat1'
    ])
  })
})

it('uses the literal source before main host lookup and durably keeps presentation-only labels out of it', async () => {
  const { store } = await setup()
  const tabId = 'structured-agent-session-chat1'
  const hostLookup = vi.fn((workspace: string) => (workspace === O ? ['local' as const] : []))
  const generated = await applyWindowLayoutCommand(store, hostLookup, {
    type: 'renameTab',
    workspace: D,
    tabId,
    kind: 'generated',
    title: 'Real content name',
    replaceExisting: true
  })
  expect(generated.ok).toBe(true)
  expect(hostLookup).toHaveBeenCalledWith(O, tabId)
  expect(store.getWorkspaceSession().unifiedTabs?.[O]?.[0].generatedLabel).toBe('Real content name')
  const custom = await applyWindowLayoutCommand(store, hostLookup, {
    type: 'renameTab',
    workspace: D,
    tabId,
    kind: 'custom',
    title: 'User decoration'
  })
  expect(custom.ok).toBe(true)
  expect(store.getWorkspaceSession().unifiedTabs?.[O]?.[0].customLabel).toBe('Saved name')
  expect(view(store).tabs.find((tab) => tab.id === tabId)?.customLabel).toBe('User decoration')
  expect(view(store).layout).toEqual(split)
})

it('runs the real CLI over runtime RPC and keeps literal source inventories independent of U', async () => {
  const { store, directory } = await setup()
  await applyWindowLayoutCommand(store, () => ['local'], {
    type: 'createTerminalTab',
    workspace: O,
    tabId: 'terminal-o',
    leafId: '11111111-1111-4111-8111-111111111111',
    groupId: 'left'
  })
  await applyWindowLayoutCommand(store, () => ['local'], {
    type: 'createTerminalTab',
    workspace: D,
    tabId: 'terminal-d',
    leafId: '22222222-2222-4222-8222-222222222222',
    groupId: 'right'
  })
  const runtime = new OrcaRuntimeService(store)
  // The window publishes mounted surfaces using the genuine resources returned by main.
  const session = store.getWorkspaceSession()
  const terminals = Object.entries(session.tabsByWorktree).flatMap(([worktreeId, tabs]) =>
    tabs.map((tab) => ({ tab, worktreeId }))
  )
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: terminals.map(({ tab, worktreeId }) => ({
      tabId: tab.id,
      worktreeId,
      title: tab.title,
      activeLeafId: session.terminalLayoutsByTabId[tab.id]?.activeLeafId ?? null,
      layout: null
    })),
    leaves: terminals.flatMap(({ tab, worktreeId }, index) => {
      const leafId = session.terminalLayoutsByTabId[tab.id]?.activeLeafId
      return leafId
        ? [
            {
              tabId: tab.id,
              worktreeId,
              leafId,
              paneRuntimeId: index + 1,
              ptyId: `pty-${tab.id}`,
              paneTitle: null,
              title: tab.title
            }
          ]
        : []
    })
  })
  const server = new OrcaRuntimeRpcServer({ runtime, userDataPath: directory })
  await server.start()
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const client = new RuntimeClient(directory, 5000, null, null)
    await dispatch(['terminal', 'list'], {
      flags: new Map([['worktree', `id:${O}`]]),
      client,
      cwd: directory,
      json: true
    })
    const output: unknown = JSON.parse(String(log.mock.calls.at(-1)?.[0]))
    expect(output).toMatchObject({
      ok: true,
      result: { terminals: [{ tabId: 'terminal-o', worktreeId: O }] }
    })
    expect(JSON.stringify(output)).not.toContain('terminal-d')
    await dispatch(['terminal', 'list'], {
      flags: new Map([['worktree', `id:${D}`]]),
      client,
      cwd: directory,
      json: true
    })
    const destination: unknown = JSON.parse(String(log.mock.calls.at(-1)?.[0]))
    expect(destination).toMatchObject({
      ok: true,
      result: { terminals: [{ tabId: 'terminal-d', worktreeId: D }] }
    })
    expect(JSON.stringify(destination)).not.toContain('terminal-o')
    const { terminals: live } = await runtime.listTerminals(`id:${O}`)
    await dispatch(['terminal', 'rename'], {
      flags: new Map([
        ['terminal', live[0].handle],
        ['title', 'CLI saved title']
      ]),
      client,
      cwd: directory,
      json: true
    })
    expect(store.getWorkspaceSession().tabsByWorktree[O][0].customTitle).toBeNull()
    expect(store.getWorkspaceSession().tabsByWorktree[D][0].customTitle).toBeNull()
    expect(view(store).tabs.find((tab) => tab.entityId === 'terminal-o')?.customLabel).toBe(
      'CLI saved title'
    )
  } finally {
    log.mockRestore()
    await server.stop()
  }
})
