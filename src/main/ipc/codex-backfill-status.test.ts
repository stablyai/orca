import { describe, expect, it, vi, beforeEach } from 'vitest'

const { pendingMock, readMock, systemHomeMock, managedHomeMock } = vi.hoisted(() => ({
  pendingMock: vi.fn<() => boolean>(),
  readMock: vi.fn(),
  systemHomeMock: vi.fn(() => '/real/.codex'),
  managedHomeMock: vi.fn<() => string | null>(() => '/managed/home')
}))

vi.mock('../codex/codex-state-db', () => ({
  isCodexBackfillIndexPending: pendingMock,
  readCodexStateDbBackfillStatus: readMock
}))
vi.mock('../codex/codex-home-paths', () => ({
  getSystemCodexHomePath: systemHomeMock,
  getOrcaManagedCodexHomePath: managedHomeMock
}))

import { getCodexBackfillGateStatus } from './codex-backfill-status'

beforeEach(() => {
  vi.clearAllMocks()
  managedHomeMock.mockReturnValue('/managed/home')
})

describe('getCodexBackfillGateStatus', () => {
  it('reports pending with the cursor for the system home on the real-home lane', () => {
    pendingMock.mockReturnValue(true)
    readMock.mockReturnValue({
      kind: 'incomplete',
      stateDbPath: '/real/.codex/state_5.sqlite',
      status: 'running',
      lastWatermark: 'sessions/2026/07/02/rollout-x.jsonl'
    })

    const status = getCodexBackfillGateStatus({ isHostSystemDefaultRealHome: () => true })

    expect(pendingMock).toHaveBeenCalledWith('/real/.codex')
    expect(status).toEqual({ pending: true, lastWatermark: 'sessions/2026/07/02/rollout-x.jsonl' })
  })

  it('targets the managed home off the real-home lane', () => {
    pendingMock.mockReturnValue(false)

    const status = getCodexBackfillGateStatus({ isHostSystemDefaultRealHome: () => false })

    expect(pendingMock).toHaveBeenCalledWith('/managed/home')
    expect(status).toEqual({ pending: false, lastWatermark: null })
  })

  it('fails open when no managed home path resolves', () => {
    managedHomeMock.mockReturnValue(null)

    const status = getCodexBackfillGateStatus({ isHostSystemDefaultRealHome: () => false })

    expect(status).toEqual({ pending: false, lastWatermark: null })
    expect(pendingMock).not.toHaveBeenCalled()
  })
})
