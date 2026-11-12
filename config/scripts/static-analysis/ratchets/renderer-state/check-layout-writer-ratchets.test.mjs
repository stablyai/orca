import { describe, expect, it } from 'vitest'
import { countLayoutWrites, RATCHETS } from './check-layout-writer-ratchets.mjs'

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

  it('distinguishes typed function registries from layout-value maps', () => {
    const src = [
      'const factories: { [K in Field]: (source: Rows<K>) => Draft<K> } = { tabsByWorktree: tabBucketDraft, terminalLayoutsByTabId: recordDraft }',
      'const next: { [K in Field]: TerminalTab[] } = { tabsByWorktree: tabs }',
      'set({ tabsByWorktree: next })'
    ].join('\n')
    expect(countLayoutWrites(src, rendererRatchet, 'a.ts')).toBe(2)
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
