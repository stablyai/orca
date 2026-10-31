import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'
import { admittedWindowPresentationCommit } from '../../ipc/workspace-presentation-window-commit'
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
const key = workspacePresentationKey('window', { hostId: 'local', workspaceId: D })
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
    owner: 'window',
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
function exactU(store: Store) {
  expect(view(store)).toMatchObject({ layout: split, activeGroupId: 'left' })
  expect(
    view(store).tabs.map((tab) => [tab.entityId, tab.worktreeId, tab.groupId, tab.customLabel])
  ).toEqual([
    ['chat1', O, 'left', 'Saved name'],
    ['chat2', D, 'right', null]
  ])
}
describe('profile-owned source and presentation checkpoint', () => {
  it('commits exact U through SQLite, cold hydration and actual main admission/withdrawal without rewriting O', async () => {
    const { store, authority, directory } = await setup()
    const capture = authority.captures.at(-1)!
    expect(capture.map(({ domain }) => domain)).toEqual(
      expect.arrayContaining(['workspaceSession', key])
    )
    exactU(store)
    await store.freezeWritesAsync()
    const reopened = await openTopologyStore(directory)
    stores.push(reopened)
    exactU(reopened)
    await expect(
      reopened.admitTerminalPane({
        type: 'createTerminalTab',
        workspace: D,
        groupId: 'right',
        tabId: 'terminal',
        leafId: '11111111-1111-4111-8111-111111111111'
      })
    ).resolves.toBe('admitted')
    expect(view(reopened)).toMatchObject({ layout: split, activeGroupId: 'left' })
    expect(view(reopened).tabs.map((tab) => tab.entityId)).toEqual(['chat1', 'chat2', 'terminal'])
    expect(reopened.getWorkspaceSession().unifiedTabs?.[O]?.[0].worktreeId).toBe(O)
    await reopened.withdrawTerminalPane({
      type: 'closePane',
      workspace: D,
      tabId: 'terminal',
      leafId: '11111111-1111-4111-8111-111111111111'
    })
    exactU(reopened)
  })
  it('indexes main publication once and serializes only the affected presentation at N/10N', async () => {
    const measure = async (count: number) => {
      const { store, authority, session, document } = await setup()
      const presentations: Record<
        ReturnType<typeof workspacePresentationKey>,
        WorkspacePresentation
      > = {}
      const unifiedTabs = { ...session.unifiedTabs }
      for (let at = 0; at < count; at++) {
        const workspaceId = `repo-${at}::C:/workspace-${at}`
        const source = { hostId: 'local' as const, workspaceId }
        const own = {
          ...document,
          anchor: source,
          displayWorkspaceId: workspaceId,
          baseline: [{ ...document.baseline[0], source }]
        }
        presentations[workspacePresentationKey('window', source)] = own
        unifiedTabs[workspaceId] = session.unifiedTabs[O].map((tab) => ({
          ...tab,
          worktreeId: workspaceId
        }))
      }
      await store.commitWorkspacePresentation({
        mode: 'replace',
        sessions: [{ state: { ...session, unifiedTabs } }],
        presentations
      })
      const stored = store.getWorkspacePresentations()
      let unrelatedVisits = 0,
        changedVisits = 0
      const target = 'repo-0::C:/workspace-0'
      const targetKey = workspacePresentationKey('window', { hostId: 'local', workspaceId: target })
      for (const [domain, value] of Object.entries(stored)) {
        if (!value) {
          continue
        }
        const baseline = value.baseline
        Object.defineProperty(value, 'baseline', {
          enumerable: true,
          configurable: true,
          get: () => {
            if (domain === targetKey) {
              changedVisits++
            } else {
              unrelatedVisits++
            }
            return baseline
          }
        })
      }
      const titles = {
        ...unifiedTabs,
        [target]: unifiedTabs[target].map((tab) => ({ ...tab, label: 'new source title' }))
      }
      store.setWorkspaceSession({ ...store.getWorkspaceSession(), unifiedTabs: titles })
      await store.flushPendingOrThrowAsync({ fullCheckpoint: false })
      expect(
        authority.captures
          .at(-1)
          ?.filter(({ domain }) => domain.startsWith('workspacePresentation:'))
      ).toEqual([])
      expect(unrelatedVisits).toBe(0)
      changedVisits = 0
      store.setWorkspaceSession({
        ...store.getWorkspaceSession(),
        unifiedTabs: {
          ...titles,
          [target]: titles[target].map((tab) => ({ ...tab, customLabel: 'real owner edit' }))
        }
      })
      await store.flushPendingOrThrowAsync({ fullCheckpoint: false })
      expect(
        authority.captures
          .at(-1)
          ?.filter(({ domain }) => domain.startsWith('workspacePresentation:'))
          .map(({ domain }) => domain)
      ).toEqual([targetKey])
      expect(unrelatedVisits).toBe(0)
      return changedVisits
    }
    const small = await measure(10),
      large = await measure(100)
    expect(small).toBeGreaterThan(0)
    expect(large).toBe(small)
  })
  it('rolls back failed atomic owner commits and admissions, requeues a later save, and retains a newer edit during failure', async () => {
    const { store, authority, document, session } = await setup()
    authority.failNextWrite()
    await expect(
      store.commitWorkspacePresentation({
        mode: 'replace',
        sessions: [{ state: { ...session, unifiedTabs: { [D]: session.unifiedTabs[D] } } }],
        presentations: { [key]: { ...document, activeGroupId: 'right' } }
      })
    ).rejects.toThrow('profile_state_write_failed')
    exactU(store)
    authority.failNextWrite()
    await expect(
      store.admitTerminalPane({
        type: 'createTerminalTab',
        workspace: D,
        groupId: 'right',
        tabId: 'failed',
        leafId: '22222222-2222-4222-8222-222222222222'
      })
    ).rejects.toThrow('profile_state_write_failed')
    exactU(store)
    const gate = authority.pause()
    authority.failNextWrite()
    const pending = store.commitWorkspacePresentation({
      mode: 'patch',
      sessions: [],
      presentations: { [key]: { ...document, activeGroupId: 'right' } }
    })
    await gate.started.promise
    store.stageWorkspacePresentationCommit({
      mode: 'patch',
      sessions: [],
      presentations: {
        [key]: { ...document, activeGroupId: 'left', layout: { ...split, ratio: 0.61 } }
      }
    })
    gate.finish.resolve()
    await expect(pending).rejects.toThrow('profile_state_write_failed')
    expect(store.getWorkspacePresentations()[key]?.layout).toEqual({ ...split, ratio: 0.61 })
    await store.flushPendingOrThrowAsync()
    expect(JSON.parse(authority.inner.readSerializedState()!)[key].layout.ratio).toBe(0.61)
  })
  it('restores all staged source/domain state on a synchronous partition failure and preserves frozen partitions on full replacement', async () => {
    const { store, document, session } = await setup()
    const setSession = store.setWorkspaceSession.bind(store)
    const spy = vi.spyOn(store, 'setWorkspaceSession').mockImplementation((state, host) => {
      if (host) {
        throw new Error('partition failed')
      }
      setSession(state, host)
    })
    expect(() =>
      store.stageWorkspacePresentationCommit({
        mode: 'replace',
        sessions: [
          { state: { ...session, unifiedTabs: { [D]: session.unifiedTabs[D] } } },
          { hostId: 'runtime:box', state: session }
        ],
        presentations: { [key]: { ...document, activeGroupId: 'right' } }
      })
    ).toThrow('partition failed')
    exactU(store)
    spy.mockRestore()
    const held = admittedWindowPresentationCommit(
      {
        mode: 'replace',
        sessions: [{ state: session }],
        presentations: {},
        replacePresentations: true
      },
      { [key]: document },
      () => true
    )
    expect(held.sessions).toEqual([])
    expect(held.removedPresentations).toEqual([])
    expect(held.replacePresentations).toBe(false)
    await store.commitWorkspacePresentation(held)
    exactU(store)
  })
  it('exports/imports the full profile losslessly and intentionally removes the presentation when a replacement omits it', async () => {
    const { store, directory } = await setup()
    const exported = store.prepareProfileStateExport()
    expect(JSON.parse(exported.json)[key].layout).toEqual(split)
    const importedDirectory = mkdtempSync(join(tmpdir(), 'orca-presentation-import-'))
    directories.push(importedDirectory)
    const imported = await openTopologyStore(importedDirectory, exported.json)
    stores.push(imported)
    exactU(imported)
    await store.freezeWritesAsync()
    const replacement = new ProfileStateSqliteAuthority(
      join(directory, 'profile-state.db'),
      'topology'
    )
    const without = JSON.parse(exported.json)
    delete without[key]
    replacement.writeSerializedState(Buffer.from(JSON.stringify(without)))
    replacement.close()
    const reset = await openTopologyStore(directory)
    stores.push(reset)
    expect(reset.getWorkspacePresentations()).toEqual({})
    expect(reset.getWorkspaceSession().unifiedTabs?.[O]?.[0].entityId).toBe('chat1')
  })
  it('applies a genuine source-local structural edit within its branch without resetting untouched outer geometry', async () => {
    const { store, session } = await setup()
    const edited = structuredClone(session)
    const extra = {
      ...edited.unifiedTabs[O][0],
      id: 'new-chat',
      entityId: 'new-chat',
      groupId: 'source-second'
    }
    edited.unifiedTabs[O].push(extra)
    edited.tabGroups[O].push({
      id: 'source-second',
      worktreeId: O,
      activeTabId: extra.id,
      tabOrder: [extra.id]
    })
    edited.tabGroupLayouts[O] = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.62,
      first: split.first,
      second: { type: 'leaf', groupId: 'source-second' }
    }
    store.setWorkspaceSession(edited)
    expect(view(store).layout).toEqual({ ...split, first: edited.tabGroupLayouts[O] })
    expect(view(store).activeGroupId).toBe('left')
    expect(view(store).tabs.map((tab) => tab.entityId)).toEqual(['chat1', 'chat2', 'new-chat'])
    const directory = mkdtempSync(join(tmpdir(), 'orca-presentation-edit-'))
    directories.push(directory)
    const reopened = await openTopologyStore(directory, store.prepareProfileStateExport().json)
    stores.push(reopened)
    expect(view(reopened).layout).toEqual(view(store).layout)
    expect(view(reopened).tabs.map((tab) => tab.entityId)).toEqual(['chat1', 'chat2', 'new-chat'])
  })
  it('settles genuine old source edits once, preserves outer geometry on no-op serialization and source add/remove, and includes U in full and quit staging', async () => {
    const { store, authority, document, session } = await setup()
    store.setWorkspaceSession(JSON.parse(JSON.stringify(session)))
    exactU(store)
    const edited = structuredClone(session)
    edited.unifiedTabs[O][0].customLabel = 'Old edit'
    store.setWorkspaceSession(edited)
    expect(view(store).tabs[0].customLabel).toBe('Old edit')
    expect(view(store).layout).toEqual(split)
    store.stageWorkspacePresentationCommit(
      {
        mode: 'replace',
        sessions: [{ state: store.getWorkspaceSession() }],
        presentations: store.getWorkspacePresentations()
      },
      true
    )
    await store.flushPendingOrThrowAsync()
    const exported = JSON.parse(authority.inner.readSerializedState()!)
    expect(exported[key].tabs[0].customLabel).toBe('Old edit')
    expect(exported[key].layout).toEqual(document.layout)
    const removed = {
      ...edited,
      unifiedTabs: { ...edited.unifiedTabs, [O]: [] },
      tabGroups: { ...edited.tabGroups, [O]: [] }
    }
    store.setWorkspaceSession(removed)
    expect(view(store).tabs.map((tab) => tab.entityId)).toEqual(['chat2'])
    expect(view(store).layout).toEqual({ type: 'leaf', groupId: 'right' })
    store.setWorkspaceSession(removed)
    expect(view(store).tabs.map((tab) => tab.entityId)).toEqual(['chat2'])
  })
})

it('migrates the actual main physical source and exact presentation in one checkpoint before a cold reopen', async () => {
  const { store, directory } = await setup()
  const N = 'repo-local::C:/renamed'
  store.migrateWorktreeIdentity(hostWorktreeTarget({ id: D, hostId: 'local' }), N)
  await store.flushPendingOrThrowAsync()
  expect(store.getWorkspaceSession().unifiedTabs?.[O]?.map((tab) => tab.entityId)).toEqual([
    'chat1'
  ])
  expect(store.getWorkspaceSession().unifiedTabs?.[N]?.map((tab) => tab.entityId)).toEqual([
    'chat2'
  ])
  expect(store.getWorkspacePresentations()[key]).toBeUndefined()
  await store.freezeWritesAsync()
  const reopened = await openTopologyStore(directory)
  stores.push(reopened)
  const movedKey = workspacePresentationKey('window', { hostId: 'local', workspaceId: N })
  const saved = reopened.getWorkspacePresentations()[movedKey]!
  expect(saved).toMatchObject({
    displayWorkspaceId: N,
    anchor: { workspaceId: N },
    layout: split,
    activeGroupId: 'left'
  })
  expect(saved.tabs.map((tab) => [tab.entity.entityId, tab.groupId, tab.customLabel])).toEqual([
    ['chat1', 'left', 'Saved name'],
    ['chat2', 'right', null]
  ])
  expect(saved.baseline.map((base) => base.source.workspaceId)).toEqual([O, N])
  expect(saved.groups.every((group) => group.worktreeId === N)).toBe(true)
})
