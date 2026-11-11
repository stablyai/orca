import {
  closeTestStores,
  createStore,
  dataFile,
  makeRepo,
  readPersistedState,
  registerWorkspaceRepos,
  testState
} from '../persistence-test-harness'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { TEST_LEAF_1, TEST_LEAF_2, TEST_LEAF_LIVE } from '../persistence-session-fixtures'
import type { TerminalCheckpointFile } from '../../daemon/protocol/daemon-checkpoint-file'
import { writeTerminalHistoryMeta } from '../../daemon/history/storage/terminal-history-metadata'
import { readHostTerminalHistory } from '../../runtime/terminal/output/host-terminal-history-read'
import { SessionReadTerminalHistoryParams } from '../../../shared/rpc-contract/session-terminal-history-params'
import { buildWorkspaceSessionPayload } from '../../../renderer/src/lib/workspace/persistence/workspace-session'
import { buildWorkspaceSessionPatch } from '../../../renderer/src/lib/workspace/persistence/workspace-session-patch'

import {
  getProfileTerminalScrollbackSnapshotRoot,
  writeTerminalScrollbackSnapshotSync
} from '../../pty/scrollback/terminal-scrollback-snapshots'
import {
  rendererSession,
  rendererWithGroups,
  rendererWithLocalEdits,
  rendererWithLocalEditsSnapshot,
  sharedAnchorSaveImages
} from './runtime-admitted-terminal-membership-save.test-fixture'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const WORKTREE = 'repo1::/worktree'

function persistedTabIds(session: WorkspaceSessionState, worktreeId: string): string[] {
  return (session.tabsByWorktree?.[worktreeId] ?? []).map((tab) => tab.id)
}

async function admitUnseenHostTab(
  store: ReturnType<typeof createStore>,
  hostId = 'local'
): Promise<void> {
  expect(
    await store.admitTerminalPane(
      {
        type: 'createTerminalTab',
        workspace: WORKTREE,
        tabId: 'host-tab',
        leafId: TEST_LEAF_2,
        groupId: 'B',
        split: { besideGroupId: 'A', direction: 'right' }
      },
      hostId
    )
  ).toBe('admitted')
  expect(
    await store.persistPtyBinding(
      {
        worktreeId: WORKTREE,
        tabId: 'host-tab',
        leafId: TEST_LEAF_2,
        ptyId: 'host-pty',
        incarnationId: 'host-incarnation',
        mayCreate: false
      },
      hostId
    )
  ).toBe(true)
  const current = store.getWorkspaceSession(hostId)
  const ref = writeTerminalScrollbackSnapshotSync({
    tabId: 'host-tab',
    leafId: TEST_LEAF_2,
    buffer: 'host failure output marker',
    storage: { snapshotRoot: getProfileTerminalScrollbackSnapshotRoot(dataFile()) }
  })
  expect(ref).toBe('v1-5f23eac31426bdf28e368e8314af3a34')
  store.setWorkspaceSession(
    {
      ...current,
      terminalLayoutsByTabId: {
        ...current.terminalLayoutsByTabId,
        'host-tab': {
          ...current.terminalLayoutsByTabId['host-tab']!,
          scrollbackRefsByLeafId: { [TEST_LEAF_2]: ref! }
        }
      }
    },
    hostId
  )
}

describe('runtime-admitted terminal membership survives a stale renderer replay', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-host-membership-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it.each(['local', 'ssh:ssh-1'])(
    'retains unseen host groups, split bindings and history through stale patch, set and shutdown in %s',
    async (hostId) => {
      const store = createStore()
      if (hostId === 'local') {
        registerWorkspaceRepos(store, WORKTREE)
      } else {
        store.addRepo(
          makeRepo({ id: 'repo1', connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' })
        )
      }
      const rendererSnapshot = rendererWithLocalEditsSnapshot(store.getRepo('repo1')!)
      store.setWorkspaceSession(rendererWithGroups(), hostId)
      await admitUnseenHostTab(store, hostId)
      const historyPath = join(testState.dir, 'terminal-history')
      if (hostId === 'local') {
        const historyDir = join(historyPath, 'host-pty')
        mkdirSync(historyDir, { recursive: true })
        writeTerminalHistoryMeta(historyDir, {
          cwd: '/worktree',
          cols: 80,
          rows: 24,
          startedAt: '2026-11-10T01:00:00Z',
          endedAt: '2026-11-10T02:00:00Z',
          exitCode: 0
        })
        writeFileSync(
          join(historyDir, 'checkpoint.json'),
          JSON.stringify({
            snapshotAnsi: 'host failure output marker',
            scrollbackAnsi: '',
            rehydrateSequences: '',
            cwd: '/worktree',
            cols: 80,
            rows: 24,
            scrollbackLines: 0,
            checkpointedAt: '2026-11-10T02:00:00Z',
            modes: {
              bracketedPaste: false,
              mouseTracking: false,
              applicationCursor: false,
              alternateScreen: false
            }
          } satisfies TerminalCheckpointFile)
        )
      }
      expect(
        await store.admitTerminalPane(
          {
            type: 'splitPane',
            workspace: WORKTREE,
            tabId: 'renderer-tab',
            leafId: TEST_LEAF_1,
            direction: 'vertical',
            newLeafId: TEST_LEAF_LIVE,
            ratio: 0.65
          },
          hostId
        )
      ).toBe('admitted')
      expect(
        await store.persistPtyBinding(
          {
            worktreeId: WORKTREE,
            tabId: 'renderer-tab',
            leafId: TEST_LEAF_LIVE,
            ptyId: 'split-pty',
            incarnationId: 'split-incarnation',
            mayCreate: false
          },
          hostId
        )
      ).toBe(true)
      const stale = rendererWithLocalEdits()
      const expectedTree = {
        type: 'split',
        direction: 'vertical',
        ratio: 0.4,
        first: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', groupId: 'A' },
          second: { type: 'leaf', groupId: 'B' }
        },
        second: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.3,
          first: { type: 'leaf', groupId: 'C' },
          second: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.7,
            first: { type: 'leaf', groupId: 'D' },
            second: { type: 'leaf', groupId: 'E' }
          }
        }
      }
      store.patchWorkspaceSession(
        {
          unifiedTabs: stale.unifiedTabs,
          openFilesByWorktree: stale.openFilesByWorktree,
          browserTabsByWorktree: stale.browserTabsByWorktree
        },
        hostId
      )
      store.patchWorkspaceSession(
        {
          tabGroups: stale.tabGroups,
          tabGroupLayouts: stale.tabGroupLayouts
        },
        hostId
      )
      expect(store.getWorkspaceSession(hostId).tabGroupLayouts?.[WORKTREE]).toEqual(expectedTree)
      store.patchWorkspaceSession(
        {
          unifiedTabs: stale.unifiedTabs,
          tabGroups: stale.tabGroups,
          tabGroupLayouts: stale.tabGroupLayouts,
          openFilesByWorktree: stale.openFilesByWorktree,
          browserTabsByWorktree: stale.browserTabsByWorktree
        },
        hostId
      )
      expect(store.getWorkspaceSession(hostId).tabGroupLayouts?.[WORKTREE]).toEqual(expectedTree)
      store.setWorkspaceSession(structuredClone(stale), hostId)
      expect(store.getWorkspaceSession(hostId).tabGroupLayouts?.[WORKTREE]).toEqual(expectedTree)
      store.stageWorkspaceSessionBeforeUnload(structuredClone(stale), hostId)
      await store.flushPendingOrThrowAsync()
      const persisted = readPersistedState()
      const saved =
        hostId === 'local'
          ? persisted.workspaceSession!
          : persisted.workspaceSessionsByHostId![hostId]!
      expect(saved.tabGroupLayouts?.[WORKTREE]).toEqual(expectedTree)
      expect(persistedTabIds(saved, WORKTREE)).toEqual(['renderer-tab', 'host-tab'])
      expect(saved.tabGroups?.[WORKTREE]?.map(({ id, tabOrder }) => ({ id, tabOrder }))).toEqual([
        { id: 'A', tabOrder: ['renderer-tab'] },
        { id: 'C', tabOrder: ['browser-tab'] },
        { id: 'D', tabOrder: ['/worktree/notes.ts'] },
        { id: 'E', tabOrder: [] },
        { id: 'B', tabOrder: ['host-tab'] }
      ])
      expect(saved.unifiedTabs?.[WORKTREE]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'host-tab',
            entityId: 'host-tab',
            groupId: 'B',
            contentType: 'terminal'
          }),
          expect.objectContaining({
            id: 'browser-tab',
            groupId: 'C',
            label: 'Research',
            isPinned: true
          }),
          expect.objectContaining({
            id: '/worktree/notes.ts',
            groupId: 'D',
            label: 'Unsaved notes',
            isPreview: false
          })
        ])
      )
      expect(saved.terminalLayoutsByTabId['renderer-tab']).toMatchObject({
        root: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.65,
          first: { type: 'leaf', leafId: TEST_LEAF_1 },
          second: { type: 'leaf', leafId: TEST_LEAF_LIVE }
        },
        ptyIdsByLeafId: { [TEST_LEAF_1]: 'renderer-pty', [TEST_LEAF_LIVE]: 'split-pty' }
      })
      expect(saved.terminalLayoutsByTabId['host-tab']).toMatchObject({
        root: { type: 'leaf', leafId: TEST_LEAF_2 },
        ptyIdsByLeafId: { [TEST_LEAF_2]: 'host-pty' }
      })
      expect(saved.terminalPtyIncarnationsByPaneKey).toMatchObject({
        [`host-tab:${TEST_LEAF_2}`]: 'host-incarnation',
        [`renderer-tab:${TEST_LEAF_LIVE}`]: 'split-incarnation'
      })
      const expectHistory = async (snapshot: WorkspaceSessionState): Promise<void> => {
        if (hostId === 'local') {
          expect(snapshot.terminalLayoutsByTabId['host-tab'].scrollbackRefsByLeafId).toBeUndefined()
          const history = await readHostTerminalHistory(
            {
              getWorkspaceSessionHostIds: () => ['local'],
              getWorkspaceSession: () => snapshot
            },
            historyPath,
            SessionReadTerminalHistoryParams.parse({
              worktreeId: WORKTREE,
              tabId: 'host-tab',
              leafId: TEST_LEAF_2,
              executionHostId: 'local',
              expectedSessionId: 'host-pty'
            })
          )
          expect(history).toMatchObject({ status: 'restored', cols: 80, rows: 24, partial: false })
          if (history.status === 'restored') {
            expect(history.scrollback).toContain('host failure output marker')
          }
        } else {
          const ref =
            snapshot.terminalLayoutsByTabId['host-tab'].scrollbackRefsByLeafId?.[TEST_LEAF_2]
          expect(ref).toBe('v1-5f23eac31426bdf28e368e8314af3a34')
          expect(ref ? store.readTerminalScrollbackSnapshot(ref) : null).toBe(
            'host failure output marker'
          )
        }
      }
      await expectHistory(saved)
      expect(saved.openFilesByWorktree?.[WORKTREE]).toEqual([
        {
          filePath: '/worktree/notes.ts',
          relativePath: 'notes.ts',
          language: 'typescript',
          worktreeId: WORKTREE,
          dirtyDraftContent: 'export const marker = 42'
        }
      ])
      expect(saved.browserTabsByWorktree?.[WORKTREE]).toEqual([
        expect.objectContaining({
          id: 'browser-tab',
          url: 'https://example.test/research',
          title: 'Research',
          canGoBack: true
        })
      ])

      const exportedTree = {
        type: 'split',
        direction: 'vertical',
        ratio: 0.4,
        first: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', groupId: 'A' },
          second: { type: 'leaf', groupId: 'B' }
        },
        second: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.3,
          first: { type: 'leaf', groupId: 'C' },
          second: { type: 'leaf', groupId: 'D' }
        }
      }
      const patch = buildWorkspaceSessionPatch(rendererSnapshot, [
        'groupsByWorktree',
        'layoutByWorktree',
        'openFiles',
        'editorDrafts',
        'browserTabsByWorktree'
      ])
      store.patchWorkspaceSession(structuredClone(patch), hostId)
      expect(store.getWorkspaceSession(hostId).tabGroupLayouts?.[WORKTREE]).toEqual(exportedTree)
      const payload = buildWorkspaceSessionPayload(rendererSnapshot)
      store.setWorkspaceSession(structuredClone(payload), hostId)
      expect(store.getWorkspaceSession(hostId).tabGroupLayouts?.[WORKTREE]).toEqual(exportedTree)
      store.stageWorkspaceSessionBeforeUnload(structuredClone(payload), hostId)
      await store.flushPendingOrThrowAsync()
      const exportedState = readPersistedState()
      const exported =
        hostId === 'local'
          ? exportedState.workspaceSession!
          : exportedState.workspaceSessionsByHostId![hostId]!
      expect(exported.tabGroupLayouts?.[WORKTREE]).toEqual(exportedTree)
      expect(exported.tabGroups?.[WORKTREE]?.map(({ id, tabOrder }) => ({ id, tabOrder }))).toEqual(
        [
          { id: 'A', tabOrder: ['renderer-tab'] },
          { id: 'C', tabOrder: ['browser-tab'] },
          { id: 'D', tabOrder: ['/worktree/notes.ts'] },
          { id: 'B', tabOrder: ['host-tab'] }
        ]
      )
      expect(exported.tabsByWorktree).toEqual(saved.tabsByWorktree)
      expect(exported.terminalLayoutsByTabId).toEqual(saved.terminalLayoutsByTabId)
      expect(exported.terminalPtyIncarnationsByPaneKey).toEqual(
        saved.terminalPtyIncarnationsByPaneKey
      )
      expect(exported.unifiedTabs).toEqual(saved.unifiedTabs)
      expect(exported.openFilesByWorktree).toEqual(saved.openFilesByWorktree)
      expect(exported.browserTabsByWorktree).toEqual(saved.browserTabsByWorktree)
      await expectHistory(exported)
    }
  )

  it('grafts nested missing host branches around differently shaped shared anchors without changing unrelated buckets', async () => {
    const store = createStore()
    const other = 'repo2::/untouched'
    registerWorkspaceRepos(store, WORKTREE, other)
    const { initial, incoming } = sharedAnchorSaveImages()
    store.setWorkspaceSession(initial)
    expect(
      await store.admitTerminalPane({
        type: 'createTerminalTab',
        workspace: WORKTREE,
        tabId: 'missing-m',
        leafId: TEST_LEAF_LIVE,
        groupId: 'M',
        split: { besideGroupId: 'B', direction: 'right' }
      })
    ).toBe('admitted')
    expect(
      await store.admitTerminalPane({
        type: 'createTerminalTab',
        workspace: WORKTREE,
        tabId: 'missing-n',
        leafId: '55555555-5555-4555-8555-555555555555',
        groupId: 'N',
        split: { besideGroupId: 'M', direction: 'right' }
      })
    ).toBe('admitted')
    store.patchWorkspaceSession({
      tabGroupLayouts: {
        ...store.getWorkspaceSession().tabGroupLayouts,
        [WORKTREE]: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.61,
          first: {
            type: 'split',
            direction: 'vertical',
            ratio: 0.42,
            first: {
              type: 'split',
              direction: 'horizontal',
              ratio: 0.27,
              first: { type: 'leaf', groupId: 'A' },
              second: { type: 'leaf', groupId: 'B' }
            },
            second: { type: 'leaf', groupId: 'M' }
          },
          second: { type: 'leaf', groupId: 'N' }
        }
      }
    })
    const before = store.getWorkspaceSession()
    store.patchWorkspaceSession(
      structuredClone({
        unifiedTabs: {
          ...incoming.unifiedTabs,
          [other]: before.unifiedTabs![other]!
        },
        tabGroups: { ...incoming.tabGroups, [other]: before.tabGroups![other]! },
        tabGroupLayouts: {
          ...incoming.tabGroupLayouts,
          [other]: before.tabGroupLayouts![other]!
        },
        browserTabsByWorktree: incoming.browserTabsByWorktree
      })
    )
    const merged = store.getWorkspaceSession()
    const expectedTree = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.61,
      first: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.42,
        first: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.73,
          first: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.22,
            first: { type: 'leaf', groupId: 'A' },
            second: {
              type: 'split',
              direction: 'vertical',
              ratio: 0.37,
              first: { type: 'leaf', groupId: 'X' },
              second: { type: 'leaf', groupId: 'E' }
            }
          },
          second: { type: 'leaf', groupId: 'B' }
        },
        second: { type: 'leaf', groupId: 'M' }
      },
      second: { type: 'leaf', groupId: 'N' }
    }
    expect(merged.tabGroupLayouts?.[WORKTREE]).toEqual(expectedTree)
    expect(merged.tabsByWorktree[other]).toBe(before.tabsByWorktree[other])
    expect(merged.unifiedTabs?.[other]).toBe(before.unifiedTabs?.[other])
    expect(merged.tabGroups?.[other]).toBe(before.tabGroups?.[other])
    expect(merged.tabGroupLayouts?.[other]).toBe(before.tabGroupLayouts?.[other])
    expect(merged.terminalLayoutsByTabId).toBe(before.terminalLayoutsByTabId)

    store.patchWorkspaceSession({ activeTabId: 'anchor-tab' })
    const scalar = store.getWorkspaceSession()
    expect(scalar.tabsByWorktree).toBe(merged.tabsByWorktree)
    expect(scalar.unifiedTabs).toBe(merged.unifiedTabs)
    expect(scalar.tabGroups).toBe(merged.tabGroups)
    expect(scalar.tabGroupLayouts).toBe(merged.tabGroupLayouts)
    expect(scalar.terminalLayoutsByTabId).toBe(merged.terminalLayoutsByTabId)
    store.patchWorkspaceSession(
      structuredClone({
        unifiedTabs: scalar.unifiedTabs,
        tabGroups: scalar.tabGroups,
        tabGroupLayouts: scalar.tabGroupLayouts
      })
    )
    const noop = store.getWorkspaceSession()
    expect(noop.tabsByWorktree).toBe(scalar.tabsByWorktree)
    expect(noop.unifiedTabs).toBe(scalar.unifiedTabs)
    expect(noop.tabGroups).toBe(scalar.tabGroups)
    expect(noop.tabGroupLayouts).toBe(scalar.tabGroupLayouts)
    expect(noop.terminalLayoutsByTabId).toBe(scalar.terminalLayoutsByTabId)
    await store.flushPendingOrThrowAsync()
    const saved = readPersistedState().workspaceSession!
    expect(saved.tabGroupLayouts?.[WORKTREE]).toEqual(expectedTree)
    expect(saved.tabGroups?.[WORKTREE]?.map(({ id, tabOrder }) => ({ id, tabOrder }))).toEqual([
      { id: 'A', tabOrder: ['renderer-tab'] },
      { id: 'B', tabOrder: ['anchor-tab'] },
      { id: 'X', tabOrder: ['browser-tab'] },
      { id: 'E', tabOrder: [] },
      { id: 'M', tabOrder: ['missing-m'] },
      { id: 'N', tabOrder: ['missing-n'] }
    ])
    expect(saved.terminalLayoutsByTabId).toMatchObject({
      'renderer-tab': { ptyIdsByLeafId: { [TEST_LEAF_1]: 'renderer-pty' } },
      'anchor-tab': { ptyIdsByLeafId: { [TEST_LEAF_2]: 'anchor-pty' } },
      'missing-m': { root: { type: 'leaf', leafId: TEST_LEAF_LIVE } },
      'missing-n': {
        root: { type: 'leaf', leafId: '55555555-5555-4555-8555-555555555555' }
      }
    })
  })

  it('uses host-first composition after a real close removes the last shared anchor and never resurrects a later close', async () => {
    const store = createStore()
    registerWorkspaceRepos(store, WORKTREE)
    store.setWorkspaceSession(rendererWithGroups())
    await admitUnseenHostTab(store)
    await store.withdrawTerminalPane({
      type: 'closePane',
      workspace: WORKTREE,
      tabId: 'renderer-tab',
      leafId: TEST_LEAF_1
    })
    expect(store.getWorkspaceSession().tabGroupLayouts?.[WORKTREE]).toEqual({
      type: 'leaf',
      groupId: 'B'
    })
    const stale = rendererWithLocalEdits()
    stale.tabsByWorktree = { [WORKTREE]: [] }
    stale.terminalLayoutsByTabId = {}
    stale.unifiedTabs![WORKTREE] = stale.unifiedTabs![WORKTREE]!.filter(
      (tab) => tab.contentType !== 'terminal'
    )
    stale.tabGroups![WORKTREE] = stale.tabGroups![WORKTREE]!.filter((group) => group.id !== 'A')
    stale.tabGroupLayouts = {
      [WORKTREE]: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.3,
        first: { type: 'leaf', groupId: 'C' },
        second: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.7,
          first: { type: 'leaf', groupId: 'D' },
          second: { type: 'leaf', groupId: 'E' }
        }
      }
    }
    store.stageWorkspaceSessionBeforeUnload(structuredClone(stale))
    await store.flushPendingOrThrowAsync()
    const saved = readPersistedState().workspaceSession!
    expect(persistedTabIds(saved, WORKTREE)).toEqual(['host-tab'])
    expect(saved.tabGroupLayouts?.[WORKTREE]).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'B' },
      second: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.3,
        first: { type: 'leaf', groupId: 'C' },
        second: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.7,
          first: { type: 'leaf', groupId: 'D' },
          second: { type: 'leaf', groupId: 'E' }
        }
      }
    })
    expect(saved.terminalLayoutsByTabId['host-tab']?.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_2]: 'host-pty'
    })
    expect(store.readTerminalScrollbackSnapshot('v1-5f23eac31426bdf28e368e8314af3a34')).toBe(
      'host failure output marker'
    )
    await store.withdrawTerminalPane({
      type: 'closePane',
      workspace: WORKTREE,
      tabId: 'host-tab',
      leafId: TEST_LEAF_2
    })
    store.patchWorkspaceSession({
      unifiedTabs: saved.unifiedTabs,
      tabGroups: saved.tabGroups,
      tabGroupLayouts: saved.tabGroupLayouts
    })
    store.setWorkspaceSession(structuredClone(saved))
    store.stageWorkspaceSessionBeforeUnload(structuredClone(saved))
    await store.flushPendingOrThrowAsync()
    const closed = readPersistedState().workspaceSession!
    expect(persistedTabIds(closed, WORKTREE)).toEqual([])
    expect(closed.terminalLayoutsByTabId['host-tab']).toBeUndefined()
    expect(closed.tabGroups?.[WORKTREE]?.map((group) => group.id)).toEqual(['C', 'D', 'E'])
    expect(closed.tabGroupLayouts?.[WORKTREE]).toEqual({
      type: 'split',
      direction: 'vertical',
      ratio: 0.3,
      first: { type: 'leaf', groupId: 'C' },
      second: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.7,
        first: { type: 'leaf', groupId: 'D' },
        second: { type: 'leaf', groupId: 'E' }
      }
    })
  })

  // Authoritative retirement derives state from Store and must outrank the admission fence.

  it('refuses to bind a pane closed while its terminal started, and mints no tab for it', async () => {
    const store = await createStore()
    store.setWorkspaceSession(rendererSession())
    expect(
      await store.admitTerminalPane({
        type: 'createTerminalTab',
        workspace: WORKTREE,
        tabId: 'host-tab',
        leafId: TEST_LEAF_2
      })
    ).toBe('admitted')
    await store.withdrawTerminalPane({
      type: 'closePane',
      workspace: WORKTREE,
      tabId: 'host-tab',
      leafId: TEST_LEAF_2
    })

    expect(
      await store.persistPtyBinding({
        worktreeId: WORKTREE,
        tabId: 'host-tab',
        leafId: TEST_LEAF_2,
        ptyId: 'host-pty',
        mayCreate: false
      })
    ).toBe(false)
    expect(persistedTabIds(store.getWorkspaceSession(), WORKTREE)).toEqual(['renderer-tab'])
  })

  it('refuses to bind a split pane that moved to another tab while its terminal started', async () => {
    const store = await createStore()
    store.setWorkspaceSession(rendererSession())
    expect(
      await store.admitTerminalPane({
        type: 'splitPane',
        workspace: WORKTREE,
        tabId: 'renderer-tab',
        leafId: TEST_LEAF_1,
        direction: 'vertical',
        newLeafId: TEST_LEAF_2
      })
    ).toBe('admitted')
    await expect(
      store.moveTerminalLeafToNewTab({
        worktreeId: WORKTREE,
        sourceTabId: 'renderer-tab',
        targetTabId: 'moved-tab',
        leafId: TEST_LEAF_2,
        ptyId: null
      })
    ).resolves.toMatchObject({ status: 'moved' })

    expect(
      await store.persistPtyBinding({
        worktreeId: WORKTREE,
        tabId: 'renderer-tab',
        leafId: TEST_LEAF_2,
        ptyId: 'late-pty',
        mayCreate: false
      })
    ).toBe(false)
    const session = store.getWorkspaceSession()
    expect(session.terminalLayoutsByTabId['renderer-tab']?.root).toEqual({
      type: 'leaf',
      leafId: TEST_LEAF_1
    })
    expect(
      session.terminalLayoutsByTabId['moved-tab']?.ptyIdsByLeafId?.[TEST_LEAF_2]
    ).toBeUndefined()
  })
})
