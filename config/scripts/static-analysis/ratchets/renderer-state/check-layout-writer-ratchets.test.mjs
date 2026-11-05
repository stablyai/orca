import { describe, expect, it } from 'vitest'

import { countLayoutWrites, isScannedPath, RATCHETS } from './check-layout-writer-ratchets.mjs'

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

  it('keeps computed writes visible while excluding proven reads and typed-owner inputs', () => {
    const reads = `function readSession(hostId) {
      const domain = hostId === 'local' ? 'workspaceSession' : 'workspaceSessionsByHostId'
      const value = db.prepare('SELECT payload WHERE domain = ?').get(domain)
      runtime.dirtyProfileStateDomains.add(hostId === 'local' ? 'workspaceSession' : 'workspaceSessionsByHostId')
      return value
    }`
    expect(countLayoutWrites(reads, mainRatchet, 'a.ts')).toBe(0)
    expect(
      countLayoutWrites(
        "const key = 'workspaceSession'; state[key] = replacement",
        mainRatchet,
        'a.ts'
      )
    ).toBe(1)
    expect(
      countLayoutWrites(
        "for (const key of keys) if (key === 'workspaceSession') patch[key] = next",
        mainRatchet,
        'a.ts'
      )
    ).toBe(1)
    expect(
      countLayoutWrites(
        `function applyReplacement(mutation) {
      state[mutation.domain] = mutation.payload
    }
    applyReplacement({ domain: 'workspaceSession', payload: value })`,
        mainRatchet,
        'a.ts'
      )
    ).toBe(1)
    expect(
      countLayoutWrites(
        `function surfaceSessionReplacements() {
      return [{ domain: 'workspaceSession', payload: value }]
    }`,
        mainRatchet,
        'src/main/workspace-surfaces/surface-host-profile-session.ts'
      )
    ).toBe(0)
    expect(
      countLayoutWrites(
        `function surfaceSessionReplacements() {
      applyReplacement({ domain: 'workspaceSession', payload: value })
      return [{ domain: 'workspaceSession', payload: value }]
    }`,
        mainRatchet,
        'src/main/workspace-surfaces/surface-host-profile-session.ts'
      )
    ).toBe(1)
    expect(
      countLayoutWrites(
        `function protectSurfaceProfileSave() {
      const selected = mutation.domain === 'workspaceSession'
      return selected
    }`,
        mainRatchet,
        'src/main/workspace-surfaces/surface-profile-save.ts'
      )
    ).toBe(0)
    const projection = `function projectProfileProjectSurfaceState(state) {
      const next = { ...state }
      next.workspaceSession = projected
      runtime.state.workspaceSession = escaped
      store.setWorkspaceSession(escaped)
      return next
    }`
    expect(
      countLayoutWrites(
        projection,
        mainRatchet,
        'src/main/orca-profiles/profile-project-domain-changes.ts'
      )
    ).toBe(2)
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

describe('isScannedPath', () => {
  it('skips tests, fixtures and harnesses', () => {
    expect(isScannedPath('src/main/ipc/session.ts')).toBe(true)
    expect(isScannedPath('src/main/ipc/session.test.ts')).toBe(false)
    expect(isScannedPath('src/main/runtime/terminal-retirement-fixture.ts')).toBe(false)
    expect(isScannedPath('src/main/ipc/session.md')).toBe(false)
  })
})
