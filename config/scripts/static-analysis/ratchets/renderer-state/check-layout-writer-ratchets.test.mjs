import { describe, expect, it } from 'vitest'
import {
  analyzeLayoutWrites,
  countLayoutWrites,
  RATCHETS
} from './check-layout-writer-ratchets.mjs'

const [mainRatchet, rendererRatchet] = RATCHETS

describe('main layout writers', () => {
  it('counts Store setter calls, partition edits and session keys, not reads or types', () => {
    const src = [
      'store.setWorkspaceSession(next, hostId)',
      'const save = store.persistPtyBinding.bind(store)',
      'removeWorkspaceSessionOwners(state, ids)',
      'this.state.workspaceSession = merged',
      'session.tabsByWorktree[id] = tabs',
      'delete partition.terminalLayoutsByTabId![tabId]',
      'tab.ptyId = null',
      'const next = { ...state, workspaceSession: merged }',
      'const tabs = session.tabsByWorktree[id]',
      'type T = { workspaceSession: Session }',
      'const reply = { tabsByWorktree: tabs }',
      'exitCodes[ptyId] = code',
      'const byPty = { [ptyId]: code }'
    ].join('\n')
    expect(countLayoutWrites(src, mainRatchet, 'a.ts')).toBe(8)
  })
})

describe('renderer layout writes', () => {
  it('counts assignments, object, shorthand and string keys, not same-name copies or types', () => {
    const src = [
      'set({ tabsByWorktree: next, activeTabId })',
      'patch.tabsByWorktree![id] = tabs',
      "const KEYS = ['groupsByWorktree', 'layoutByWorktree'] as const",
      'patch[key] = value',
      'const picked = useAppStore((s) => ({ openFiles: s.openFiles }))',
      'const useTabs = () => ({ activeTabId, tabsByWorktree })',
      "type Field = Pick<AppState, 'tabsByWorktree'>",
      "const read = state['unifiedTabsByWorktree']",
      "Object.hasOwn(requested, 'terminalLayoutsByTabId')",
      'const { tabsByWorktree } = state'
    ].join('\n')
    expect(countLayoutWrites(src, rendererRatchet, 'a.tsx')).toBe(5)
  })

  it('skips content updates of existing editor and browser entries, not membership changes', () => {
    const src = [
      'set({ openFiles: s.openFiles.map((f) => (f.id === id ? { ...f, isDirty: true } : f)) })',
      'set({ browserTabsByWorktree: { ...s.browserTabsByWorktree, [wt]: (s.browserTabsByWorktree[wt] ?? []).map(withUrl) } })',
      'set({ openFiles: [...s.openFiles, file] })',
      'set({ openFiles: s.openFiles.filter((f) => f.id !== id) })',
      'set({ tabsByWorktree: s.tabsByWorktree.map(rename) })'
    ].join('\n')
    expect(countLayoutWrites(src, rendererRatchet, 'a.tsx')).toBe(3)
  })
})

const patchPath =
  'src/main/persistence/loading-store/workspace-sessions/terminal-session-cleanup.ts'
const hydrationPath = 'src/renderer/src/store/terminals/workspace-terminal-hydration.ts'
const installerPath =
  'src/renderer/src/store/terminals/retained-terminal-destination-installation.ts'
const patchConstruction = `
function prepareWorkspaceSessionTopologyPatch(patch, prior) {
  const next = { ...patch }
  if (Object.hasOwn(patch, 'unifiedTabs')) {
    next.unifiedTabs = reuseTopologyBuckets(patch.unifiedTabs, prior.unifiedTabs, worktreeIds)
  }
  if (Object.hasOwn(patch, 'tabGroups')) {
    next.tabGroups = reuseTopologyBuckets(patch.tabGroups, prior.tabGroups, worktreeIds)
  }
  if (Object.hasOwn(patch, 'tabGroupLayouts')) {
    next.tabGroupLayouts = reuseTopologyBuckets(patch.tabGroupLayouts, prior.tabGroupLayouts, worktreeIds)
  }
  return { patch: next, worktreeIds }
}`
const cohortRead = `
function createWorkspaceTerminalHydrationActions() {
  set((s) => {
    if (!options?.replaceWorkspaceKeys) {
      s.terminalStartupAttempt?.capture({
        ...s, ...hydrated, groupsByWorktree: session.tabGroups ?? s.groupsByWorktree
      })
    }
    return hydrated
  })
}`
const retainedPublication = `
function installRetainedTerminalDestination() {
  useAppStore.setState((state) => {
    const nextGroup = targetGroup ?? {
      ...group!, id: targetGroupId, tabOrder: [], activeTabId: null, recentTabIds: []
    }
    return {
      terminalLayoutsByTabId: replaceRecordEntries(state.terminalLayoutsByTabId, [[tab.id, nextLayout]]),
      ...(currentTab ? {} : {
        tabsByWorktree: replaceTabBuckets(state.tabsByWorktree, [[worktreeId, [...tabs, tab]]]),
        ptyIdsByTabId: replaceRecordEntries(state.ptyIdsByTabId, [[tab.id, []]])
      }),
      ...(existingUnified ? {} : {
        unifiedTabsByWorktree: replaceTabBuckets(state.unifiedTabsByWorktree, [[worktreeId, [...unified, {
          id: tab.id, entityId: tab.id, groupId: targetGroupId, worktreeId,
          contentType: 'terminal' as const, executionHostId: start.executionHostId,
          label: tab.title, customLabel: tab.customTitle, color: tab.color,
          sortOrder: tabOrder.indexOf(unifiedId), createdAt: tab.createdAt,
          ...(tab.viewMode ? { viewMode: tab.viewMode } : {})
        }]]])
      }),
      groupsByWorktree: replaceRecordEntries(state.groupsByWorktree, [[worktreeId,
        targetGroup ? groups.map((row) => (row.id === targetGroupId ? { ...row, tabOrder } : row)) : [...groups, { ...nextGroup, tabOrder, activeTabId: unifiedId }]
      ]]),
      layoutByWorktree: replaceRecordEntries(state.layoutByWorktree, [[worktreeId, nextGroupLayout]])
    }
  })
}`

describe('finite retained layout classifications', () => {
  it('reports construction, cohort reads and the addressed publisher separately from raw writes', () => {
    expect(analyzeLayoutWrites(patchConstruction, mainRatchet, patchPath)).toEqual({
      raw: 3,
      ordinary: 0,
      categories: { 'patch-construction': 3 }
    })
    expect(analyzeLayoutWrites(cohortRead, rendererRatchet, hydrationPath)).toEqual({
      raw: 1,
      ordinary: 0,
      categories: { 'cohort-read': 1 }
    })
    expect(analyzeLayoutWrites(retainedPublication, rendererRatchet, installerPath)).toEqual({
      raw: 8,
      ordinary: 0,
      categories: { 'retained-publisher': 8 }
    })
    expect(countLayoutWrites(retainedPublication, rendererRatchet, installerPath)).toBe(8)
  })

  it('does not grant the same sites to another path or function owner', () => {
    expect(analyzeLayoutWrites(patchConstruction, mainRatchet, 'src/main/other.ts').ordinary).toBe(
      3
    )
    expect(
      analyzeLayoutWrites(
        cohortRead.replace('createWorkspaceTerminalHydrationActions', 'publish'),
        rendererRatchet,
        hydrationPath
      ).ordinary
    ).toBe(1)
    expect(
      analyzeLayoutWrites(
        retainedPublication.replace('installRetainedTerminalDestination', 'publish'),
        rendererRatchet,
        installerPath
      ).ordinary
    ).toBe(8)
  })

  it('counts duplicate roles, aliased mutation and another writer alongside patch construction', () => {
    const source = patchConstruction.replace(
      'return { patch: next, worktreeIds }',
      `
      if (Object.hasOwn(patch, 'unifiedTabs')) {
        next.unifiedTabs = reuseTopologyBuckets(patch.unifiedTabs, prior.unifiedTabs, worktreeIds)
      }
      next.tabGroups[id] = replacement
      store.patchWorkspaceSession(next)
      return { patch: next, worktreeIds }
    `
    )
    expect(analyzeLayoutWrites(source, mainRatchet, patchPath)).toEqual({
      raw: 6,
      ordinary: 3,
      categories: { 'patch-construction': 3 }
    })
    expect(
      analyzeLayoutWrites(
        patchConstruction.replace('{ ...patch }', 'patch'),
        mainRatchet,
        patchPath
      ).ordinary
    ).toBe(3)
    expect(
      analyzeLayoutWrites(
        patchConstruction.replace(
          'const next = { ...patch }',
          'let next = { ...patch }; next = patch'
        ),
        mainRatchet,
        patchPath
      ).ordinary
    ).toBe(3)
  })

  it('counts a cohort-shaped object passed to a Store writer', () => {
    const source = cohortRead.replace('s.terminalStartupAttempt?.capture', 'useAppStore.setState')
    expect(analyzeLayoutWrites(source, rendererRatchet, hydrationPath)).toEqual({
      raw: 1,
      ordinary: 1,
      categories: {}
    })
  })

  it('counts additional global selection and duplicate topology instead of spending a removed role', () => {
    const source = retainedPublication.replace(
      'return {',
      `return {
      activeTabId: unifiedId,
      layoutByWorktree: replacement,
    `
    )
    expect(analyzeLayoutWrites(source, rendererRatchet, installerPath)).toEqual({
      raw: 10,
      ordinary: 2,
      categories: { 'retained-publisher': 8 }
    })
    expect(
      analyzeLayoutWrites(
        retainedPublication.replace(
          '[[worktreeId, nextGroupLayout]]',
          '[[anotherWorkspace, nextGroupLayout]]'
        ),
        rendererRatchet,
        installerPath
      )
    ).toEqual({
      raw: 8,
      ordinary: 1,
      categories: { 'retained-publisher': 7 }
    })
  })

  it('counts mismatched identity, missing-group construction and non-addressed group updates', () => {
    expect(
      analyzeLayoutWrites(
        retainedPublication.replace('entityId: tab.id', 'entityId: foreignTab.id'),
        rendererRatchet,
        installerPath
      )
    ).toEqual({ raw: 8, ordinary: 1, categories: { 'retained-publisher': 7 } })
    expect(
      analyzeLayoutWrites(
        retainedPublication.replace(
          'tabOrder: [], activeTabId: null',
          'tabOrder: oldOrder, activeTabId: null'
        ),
        rendererRatchet,
        installerPath
      )
    ).toEqual({ raw: 8, ordinary: 1, categories: { 'retained-publisher': 7 } })
    expect(
      analyzeLayoutWrites(
        retainedPublication.replace('row.id === targetGroupId', 'row.id !== targetGroupId'),
        rendererRatchet,
        installerPath
      )
    ).toEqual({ raw: 8, ordinary: 2, categories: { 'retained-publisher': 6 } })
  })

  it('counts a missing or foreign installed-group selection as a mismatched publication', () => {
    expect(
      analyzeLayoutWrites(
        retainedPublication.replace(
          '{ ...nextGroup, tabOrder, activeTabId: unifiedId }',
          '{ ...nextGroup, tabOrder }'
        ),
        rendererRatchet,
        installerPath
      )
    ).toEqual({ raw: 7, ordinary: 1, categories: { 'retained-publisher': 6 } })
    expect(
      analyzeLayoutWrites(
        retainedPublication.replace(
          '{ ...nextGroup, tabOrder, activeTabId: unifiedId }',
          '{ ...foreignGroup, tabOrder, activeTabId: unifiedId }'
        ),
        rendererRatchet,
        installerPath
      )
    ).toEqual({ raw: 8, ordinary: 2, categories: { 'retained-publisher': 6 } })
  })
})
