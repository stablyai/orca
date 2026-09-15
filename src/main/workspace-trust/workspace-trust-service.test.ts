import { describe, expect, it, vi, beforeEach } from 'vitest'

const { resolveWorkspaceTrustForPathMock } = vi.hoisted(() => ({
  resolveWorkspaceTrustForPathMock: vi.fn()
}))

vi.mock('./workspace-trust-path-canonicalization', () => ({
  resolveWorkspaceTrustForPath: resolveWorkspaceTrustForPathMock
}))

import {
  getWorkspaceTrustDecision,
  isWorkspaceTrusted,
  onWorkspaceTrustChanged,
  recordWorkspaceTrustDecision,
  revokeWorkspaceTrustEntry
} from './workspace-trust-service'
import type { WorkspaceTrustEntry } from '../../shared/workspace-trust-types'

type FakeSettings = { workspaceTrustEntries?: WorkspaceTrustEntry[] }

function createFakeStore(initial: FakeSettings = {}) {
  let settings: FakeSettings = { workspaceTrustEntries: [], ...initial }
  return {
    getSettings: () => settings,
    updateSettings: (updates: FakeSettings) => {
      settings = { ...settings, ...updates }
      return settings
    }
  }
}

describe('workspace-trust-service', () => {
  beforeEach(() => {
    resolveWorkspaceTrustForPathMock.mockReset()
  })

  it('remembers a decline so re-querying the same path stays untrusted with no re-prompt', async () => {
    const store = createFakeStore()

    await recordWorkspaceTrustDecision(store, {
      path: '/home/user/downloads',
      scope: 'workspace',
      decision: 'decline',
      origin: 'intake'
    })

    expect(await getWorkspaceTrustDecision('/home/user/downloads', store)).toBe('declined')
  })

  it('resolves trust through the two-phase canonicalization module', async () => {
    resolveWorkspaceTrustForPathMock.mockResolvedValue(true)
    const store = createFakeStore({
      workspaceTrustEntries: [
        { id: 'e1', path: '/home/user/work', trusted: true, decidedAt: 1, origin: 'intake' }
      ]
    })

    expect(await isWorkspaceTrusted('/home/user/work/proj', store)).toBe(true)
    expect(resolveWorkspaceTrustForPathMock).toHaveBeenCalledWith(
      '/home/user/work/proj',
      store.getSettings().workspaceTrustEntries
    )
  })

  it('revoking an entry makes the path resolve untrusted on the next query', async () => {
    resolveWorkspaceTrustForPathMock.mockResolvedValue(false)
    const store = createFakeStore({
      workspaceTrustEntries: [
        { id: 'e1', path: '/home/user/work', trusted: true, decidedAt: 1, origin: 'intake' }
      ]
    })

    const revoked = await revokeWorkspaceTrustEntry(store, 'e1')

    expect(revoked).toBe(true)
    expect(store.getSettings().workspaceTrustEntries).toEqual([])
    expect(await isWorkspaceTrusted('/home/user/work', store)).toBe(false)
  })

  it('emits a trust-change event with changedRoots, revision, and reason on grant, decline, and revoke', async () => {
    const store = createFakeStore()
    const changes: { changedRoots: string[]; revision: number; reason: string }[] = []
    const dispose = onWorkspaceTrustChanged((change) => changes.push(change))

    const granted = await recordWorkspaceTrustDecision(store, {
      path: '/home/user/work',
      scope: 'workspace',
      decision: 'trust',
      origin: 'intake'
    })
    await revokeWorkspaceTrustEntry(store, granted.id)

    dispose()
    await recordWorkspaceTrustDecision(store, {
      path: '/home/user/other',
      scope: 'workspace',
      decision: 'decline',
      origin: 'intake'
    })

    expect(changes).toHaveLength(2)
    expect(changes[0]).toMatchObject({ changedRoots: ['/home/user/work'], reason: 'granted' })
    expect(changes[1]).toMatchObject({ changedRoots: ['/home/user/work'], reason: 'revoked' })
    expect(changes[1].revision).toBeGreaterThan(changes[0].revision)
  })
  // Why: persistence only fires listeners when the caller opts in, and the `settings:changed`
  // broadcast is what carries a decision to open windows. Writing without it leaves every
  // rendered surface showing the previous decision until the next full settings fetch.
  it('asks persistence to notify listeners so a decision reaches open windows', async () => {
    const updateSettings = vi.fn((updates: FakeSettings) => updates)
    const store = { getSettings: () => ({ workspaceTrustEntries: [] }), updateSettings }

    await recordWorkspaceTrustDecision(store, {
      path: '/home/user/project',
      scope: 'workspace',
      decision: 'trust',
      origin: 'intake'
    })

    expect(updateSettings).toHaveBeenCalledWith(expect.anything(), { notifyListeners: true })
  })

  it('notifies listeners on revoke too, so a revoked decision stops being displayed as current', async () => {
    const entry: WorkspaceTrustEntry = {
      id: 'entry-1',
      path: '/home/user/project',
      trusted: true,
      decidedAt: 1,
      origin: 'intake'
    }
    const updateSettings = vi.fn((updates: FakeSettings) => updates)
    const store = { getSettings: () => ({ workspaceTrustEntries: [entry] }), updateSettings }

    await revokeWorkspaceTrustEntry(store, 'entry-1')

    expect(updateSettings).toHaveBeenCalledWith(expect.anything(), { notifyListeners: true })
  })
})
