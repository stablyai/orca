import { describe, expect, it, vi } from 'vitest'

vi.mock('../daemon/daemon-init', () => ({
  requestIdleDaemonRetirement: vi.fn(),
  listLiveDaemonSessions: vi.fn(),
  releaseDaemonRetirementFence: vi.fn()
}))

import type { DaemonIdleRetirementResult } from '../daemon/daemon-pty-runtime-state'
import { retireOrcadDaemonIfIdle } from './orcad-daemon-retirement'

function ports(
  result: () => Promise<DaemonIdleRetirementResult>,
  liveSessions: number | null = null
) {
  return {
    request: vi.fn(result),
    releaseFence: vi.fn(),
    countLiveSessions: vi.fn(async () => liveSessions),
    timeoutMs: 20
  }
}

describe('best-effort daemon retirement', () => {
  it('reports retired only when the daemon accepted, and keeps its fence', async () => {
    const retiring = ports(async () => ({ state: 'retiring' }))
    expect(await retireOrcadDaemonIfIdle(retiring)).toMatchObject({ retirement: 'retired' })
    expect(retiring.releaseFence).not.toHaveBeenCalled()
  })

  it('leaves a busy daemon running, reopens admission, and reports live', async () => {
    const busy = ports(async () => ({ state: 'busy', liveSessions: 3 }))
    expect(await retireOrcadDaemonIfIdle(busy)).toMatchObject({
      retirement: 'live',
      liveSessions: 3
    })
    expect(busy.releaseFence).toHaveBeenCalledOnce()
  })

  it('counts sessions itself when the daemon did not say how many', async () => {
    const busy = ports(async () => ({ state: 'busy', liveSessions: null }), 1)
    expect(await retireOrcadDaemonIfIdle(busy)).toMatchObject({
      retirement: 'live',
      liveSessions: 1
    })
  })

  it.each([
    [
      'an unsupported daemon',
      async (): Promise<DaemonIdleRetirementResult> => ({ state: 'unsupported' })
    ],
    [
      'an unverifiable census',
      async (): Promise<DaemonIdleRetirementResult> => ({ state: 'unverifiable' })
    ],
    [
      'lost contact',
      async (): Promise<DaemonIdleRetirementResult> => {
        throw new Error('socket closed')
      }
    ],
    ['no answer', () => new Promise<DaemonIdleRetirementResult>(() => {})]
  ])('never reads %s as idle, and reopens admission', async (_name, result) => {
    const unanswered = ports(result)
    expect(await retireOrcadDaemonIfIdle(unanswered)).toMatchObject({
      retirement: 'unverifiable',
      liveSessions: null
    })
    expect(unanswered.releaseFence).toHaveBeenCalledOnce()
  })
})
