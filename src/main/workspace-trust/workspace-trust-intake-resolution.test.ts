import { describe, expect, it, vi, beforeEach } from 'vitest'

const { resolveWorkspaceTrustForPathMock } = vi.hoisted(() => ({
  resolveWorkspaceTrustForPathMock: vi.fn()
}))

vi.mock('./workspace-trust-path-canonicalization', () => ({
  resolveWorkspaceTrustForPath: resolveWorkspaceTrustForPathMock
}))

import { resolveWorkspaceTrustIntake } from './workspace-trust-intake-resolution'
import type { WorkspaceTrustEntry } from '../../shared/workspace-trust-types'

function createFakeStore(entries: WorkspaceTrustEntry[]) {
  return {
    getSettings: () => ({ workspaceTrustEntries: entries }),
    updateSettings: () => ({ workspaceTrustEntries: entries })
  }
}

describe('resolveWorkspaceTrustIntake', () => {
  beforeEach(() => {
    resolveWorkspaceTrustForPathMock.mockReset()
    resolveWorkspaceTrustForPathMock.mockResolvedValue(true)
  })

  it('inherits trust from a trusted ancestor', async () => {
    const store = createFakeStore([
      { id: 'a', path: '/home/user/work', trusted: true, decidedAt: 1, origin: 'intake' }
    ])

    const resolution = await resolveWorkspaceTrustIntake('/home/user/work/proj', store, 'added')

    expect(resolution).toEqual({ outcome: 'inherit-trusted', inheritedFrom: '/home/user/work' })
  })

  it('still prompts a new repo beneath a declined ancestor, not suppressed by the decline', async () => {
    const store = createFakeStore([
      { id: 'a', path: '/home/downloads', trusted: false, decidedAt: 1, origin: 'intake' }
    ])

    const resolution = await resolveWorkspaceTrustIntake(
      '/home/downloads/one-good-repo',
      store,
      'added'
    )

    expect(resolution).toEqual({
      outcome: 'prompt',
      reason: 'ancestor-declined',
      ancestorPath: '/home/downloads'
    })
  })

  it('never re-prompts the same declined path', async () => {
    const store = createFakeStore([
      { id: 'a', path: '/home/user/repo-x', trusted: false, decidedAt: 1, origin: 'intake' }
    ])

    const resolution = await resolveWorkspaceTrustIntake('/home/user/repo-x', store, 'added')

    expect(resolution).toEqual({ outcome: 'already-declined', declinedEntryId: 'a' })
  })

  it('prompts when nothing covers the path', async () => {
    const store = createFakeStore([])

    const resolution = await resolveWorkspaceTrustIntake('/home/user/fresh', store, 'cloned')

    expect(resolution).toEqual({ outcome: 'prompt', reason: 'no-decision' })
  })

  it('lets a child grant beneath a declined ancestor override it via longest-prefix', async () => {
    const store = createFakeStore([
      { id: 'ancestor', path: '/home/downloads', trusted: false, decidedAt: 1, origin: 'intake' },
      {
        id: 'child',
        path: '/home/downloads/one-good-repo',
        trusted: true,
        decidedAt: 2,
        origin: 'intake'
      }
    ])

    const resolution = await resolveWorkspaceTrustIntake(
      '/home/downloads/one-good-repo',
      store,
      'added'
    )

    expect(resolution).toEqual({
      outcome: 'inherit-trusted',
      inheritedFrom: '/home/downloads/one-good-repo'
    })
  })

  it('degrades to prompt when phase-2 canonical re-verification disqualifies an ancestor grant', async () => {
    resolveWorkspaceTrustForPathMock.mockResolvedValue(false)
    const store = createFakeStore([
      { id: 'a', path: '/home/user/work', trusted: true, decidedAt: 1, origin: 'intake' }
    ])

    const resolution = await resolveWorkspaceTrustIntake('/home/user/work/proj', store, 'added')

    expect(resolution).toEqual({ outcome: 'prompt', reason: 'no-decision' })
  })

  it('reaches the same decision for a folder workspace and a repo at the same path (shared choke point)', async () => {
    const store = createFakeStore([
      { id: 'a', path: '/home/user/work', trusted: true, decidedAt: 1, origin: 'intake' }
    ])

    const repoResolution = await resolveWorkspaceTrustIntake('/home/user/work/proj', store, 'added')
    const folderResolution = await resolveWorkspaceTrustIntake(
      '/home/user/work/proj',
      store,
      'folder-workspace'
    )

    expect(repoResolution).toEqual(folderResolution)
  })
})
