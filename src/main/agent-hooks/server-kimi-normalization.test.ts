import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _internals } from './server'
import { buildBody } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Kimi hook normalization', () => {
  it('carries the wrapper-reported hookCwd onto the event (#10572)', () => {
    const result = _internals.normalizeHookPayload(
      'kimi',
      buildBody(
        { hook_event_name: 'UserPromptSubmit', prompt: 'rebase the branch' },
        { hookCwd: '/repo/wt-alpha' }
      ),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.hookCwd).toBe('/repo/wt-alpha')
  })

  it('leaves hookCwd absent when the wrapper did not send it', () => {
    const result = _internals.normalizeHookPayload(
      'kimi',
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'rebase the branch' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.hookCwd).toBeUndefined()
  })
})
