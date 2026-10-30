import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { coordinatorMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./pr-refresh-coordinator-test-mocks')
  return { coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks(), moduleMocks }
})
vi.mock('electron', () => moduleMocks.electronModuleMock(coordinatorMocks))

import { makeCandidate } from './pr-refresh-coordinator-test-harness'
import { refreshKey } from './pr-refresh-candidate-policy'
import { PRRefreshVisibility } from './pr-refresh-visibility'

const { getAllWebContentsMock, webContentsFromIdMock } = coordinatorMocks

describe('PR refresh owner liveness', () => {
  beforeEach(() => moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks))
  afterEach(() => vi.useRealTimers())

  it('checks only recorded owners by ID instead of a native census', () => {
    const registry = new Map(
      Array.from({ length: 1_000 }, (_, index) => {
        const id = index + 1
        return [id, { id, isDestroyed: () => false }] as const
      })
    )
    getAllWebContentsMock.mockImplementation(() => Array.from(registry.values()))
    webContentsFromIdMock.mockImplementation((id) => registry.get(id))
    const candidates = Array.from({ length: 100 }, (_, index) =>
      makeCandidate({ branch: `feature/${index}`, cacheKey: `/repo::feature/${index}` })
    )
    const visibility = new PRRefreshVisibility()
    visibility.report(candidates, 1, 1)

    expect(candidates.every((candidate) => visibility.has(refreshKey(candidate)))).toBe(true)
    expect(visibility.report(candidates, 2, 1)).toBe(true)
    expect(visibility.windowCount).toBe(1)
    expect(getAllWebContentsMock).not.toHaveBeenCalled()
    expect(webContentsFromIdMock.mock.calls.every(([id]) => id === 1)).toBe(true)
  })

  it('does no native work without recorded owners', () => {
    const visibility = new PRRefreshVisibility()
    expect(visibility.has(refreshKey(makeCandidate()))).toBe(false)
    expect(visibility.windowCount).toBe(0)
    expect(getAllWebContentsMock).not.toHaveBeenCalled()
    expect(webContentsFromIdMock).not.toHaveBeenCalled()
  })

  it('prunes missing and destroyed owners while checking surviving owners afresh', () => {
    const destroyed = vi.fn(() => false)
    const registry = new Map([
      [1, { id: 1, isDestroyed: () => false }],
      [2, { id: 2, isDestroyed: destroyed }],
      [3, { id: 3, isDestroyed: () => false }]
    ])
    getAllWebContentsMock.mockImplementation(() => Array.from(registry.values()))
    webContentsFromIdMock.mockImplementation((id) => registry.get(id))
    const visibility = new PRRefreshVisibility()
    const candidate = makeCandidate()
    for (const id of registry.keys()) {
      visibility.report([candidate], 1, id)
    }
    registry.delete(1)
    destroyed.mockReturnValue(true)
    webContentsFromIdMock.mockClear()
    expect(visibility.has(refreshKey(candidate))).toBe(true)
    expect(visibility.windowCount).toBe(1)
    expect(webContentsFromIdMock.mock.calls).toEqual([[1], [2], [3]])
    registry.delete(3)
    webContentsFromIdMock.mockClear()
    expect(visibility.has(refreshKey(candidate))).toBe(false)
    expect(webContentsFromIdMock.mock.calls).toEqual([[3]])
    expect(visibility.windowCount).toBe(0)
  })

  it('prunes an old owner at the next report boundary', () => {
    const registry = new Map([
      [1, { id: 1, isDestroyed: () => false }],
      [2, { id: 2, isDestroyed: () => false }]
    ])
    getAllWebContentsMock.mockImplementation(() => Array.from(registry.values()))
    webContentsFromIdMock.mockImplementation((id) => registry.get(id))
    const visibility = new PRRefreshVisibility()
    const first = makeCandidate()
    const second = makeCandidate({ branch: 'feature/second', cacheKey: '/repo::feature/second' })
    visibility.report([first], 1, 1)
    registry.delete(1)
    expect(visibility.report([second], 1, 2)).toBe(true)
    expect(visibility.windowCount).toBe(1)
    expect(visibility.has(refreshKey(first))).toBe(false)
    expect(visibility.has(refreshKey(second))).toBe(true)
  })

  it('retains generation, cached fields and surviving selection ownership', () => {
    const registry = new Map([
      [1, { id: 1, isDestroyed: () => false }],
      [2, { id: 2, isDestroyed: () => false }]
    ])
    getAllWebContentsMock.mockImplementation(() => Array.from(registry.values()))
    webContentsFromIdMock.mockImplementation((id) => registry.get(id))
    const visibility = new PRRefreshVisibility()
    const candidate = makeCandidate({ cachedFetchedAt: 1, cachedHeadOid: 'old-head' })
    const key = refreshKey(candidate)
    visibility.report([{ ...candidate, isSelected: true }], 2, 1)
    visibility.report([candidate], 1, 2)
    visibility.update({ ...candidate, cachedFetchedAt: 3, cachedHeadOid: 'new-head' })
    expect(visibility.report([], 1, 1)).toBe(false)
    expect(visibility.candidate(key, candidate)).toMatchObject({
      isSelected: true,
      cachedFetchedAt: 3,
      cachedHeadOid: 'new-head'
    })
    expect(visibility.report([candidate], 3, 1)).toBe(true)
    expect(visibility.candidate(key, candidate)).toMatchObject({
      isSelected: false,
      cachedFetchedAt: 3,
      cachedHeadOid: 'new-head'
    })
    visibility.report([{ ...candidate, isSelected: true }], 2, 2)
    expect(visibility.clearWindow(1)).toBe(true)
    expect(visibility.has(key)).toBe(true)
    expect(visibility.candidate(key, candidate)).toMatchObject({ isSelected: true })
    registry.delete(2)
    expect(visibility.has(key)).toBe(false)
  })
})
