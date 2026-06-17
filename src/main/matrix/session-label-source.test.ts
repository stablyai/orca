import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { paneKeyForHandle } from './session-handle-registry'
import {
  registerSpeakingHandle,
  resetSpeakingHandleCacheForTests,
  resolveSessionLabel,
  type SessionLabelStore
} from './session-label-source'

// A worktree id is `${repoId}::${path}` — getRepoIdFromWorktreeId splits on `::`.
const WORKTREE_ID = 'repo-1::/src/orca'

function makeStore(overrides: Partial<SessionLabelStore> = {}): SessionLabelStore {
  return {
    getWorktreeMeta: () => undefined,
    getRepo: () => undefined,
    ...overrides
  }
}

describe('resolveSessionLabel', () => {
  it('prefers the worktree display name', () => {
    const store = makeStore({
      getWorktreeMeta: () => ({ displayName: 'matrix-adapter' }),
      getRepo: () => ({ displayName: 'orca' })
    })
    expect(resolveSessionLabel(store, WORKTREE_ID)).toBe('matrix-adapter')
  })

  it('falls back to the repo display name when the worktree name is blank', () => {
    const store = makeStore({
      getWorktreeMeta: () => ({ displayName: '   ' }),
      getRepo: (repoId) => (repoId === 'repo-1' ? { displayName: 'orca' } : undefined)
    })
    expect(resolveSessionLabel(store, WORKTREE_ID)).toBe('orca')
  })

  it('returns undefined when there is no worktree id', () => {
    expect(resolveSessionLabel(makeStore(), undefined)).toBeUndefined()
  })

  it('returns undefined when neither name is available', () => {
    expect(resolveSessionLabel(makeStore(), WORKTREE_ID)).toBeUndefined()
  })
})

describe('registerSpeakingHandle', () => {
  let tempHome: string
  let originalHome: string | undefined

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'orca-matrix-label-'))
    originalHome = process.env.HOME
    process.env.HOME = tempHome
    resetSpeakingHandleCacheForTests()
  })

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    rmSync(tempHome, { recursive: true, force: true })
  })

  it('registers a handle from the worktree display name', () => {
    const store = makeStore({ getWorktreeMeta: () => ({ displayName: 'matrix-adapter' }) })
    const handle = registerSpeakingHandle(store, 'tab:leaf', WORKTREE_ID)
    expect(handle).toBe('matrix-adapter')
    expect(paneKeyForHandle('matrix-adapter')).toBe('tab:leaf')
  })

  it('does not register (or mint a fallback slug) when no label resolves yet', () => {
    // A fallback minted here would be persisted and permanently shadow the
    // speaking name; leave the session unregistered so a later event can name it.
    expect(registerSpeakingHandle(makeStore(), 'tab:leaf', undefined)).toBeUndefined()
    expect(paneKeyForHandle('tab')).toBeNull()
  })

  it('names a session on a later event once the label becomes available', () => {
    let name: string | undefined
    const store = makeStore({ getWorktreeMeta: () => (name ? { displayName: name } : undefined) })
    // First event: metadata not loaded yet → unregistered.
    expect(registerSpeakingHandle(store, 'tab:leaf', WORKTREE_ID)).toBeUndefined()
    // Later event: label now resolves → speaking handle minted.
    name = 'matrix-adapter'
    expect(registerSpeakingHandle(store, 'tab:leaf', WORKTREE_ID)).toBe('matrix-adapter')
  })

  it('skips re-registration for an already-ensured pane key this run', () => {
    const store = makeStore({ getWorktreeMeta: () => ({ displayName: 'matrix-adapter' }) })
    expect(registerSpeakingHandle(store, 'tab:leaf', WORKTREE_ID)).toBe('matrix-adapter')
    // Second call is cached — returns undefined, but the handle stays resolvable.
    expect(registerSpeakingHandle(store, 'tab:leaf', WORKTREE_ID)).toBeUndefined()
    expect(paneKeyForHandle('matrix-adapter')).toBe('tab:leaf')
  })
})
