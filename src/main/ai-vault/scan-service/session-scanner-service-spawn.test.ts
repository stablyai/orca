import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AiVaultServiceTestChild,
  aiVaultServiceRequestId,
  readyAiVaultServiceChild
} from './session-scanner-service-test-child'

const forkMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ fork: forkMock }))
vi.mock('node:fs', () => ({ existsSync: () => true }))

const {
  resetAiVaultScannerServiceForTests,
  resolveAiVaultSessionTitlesInService,
  setAiVaultServiceIdleTimeoutMs
} = await import('./session-scanner-service-spawn')

describe('the shared scanner client', () => {
  afterEach(() => {
    resetAiVaultScannerServiceForTests()
    vi.useRealTimers()
  })

  it('retires an idle child after the timeout an orcad host configured', async () => {
    vi.useFakeTimers()
    const child = new AiVaultServiceTestChild(4242)
    forkMock.mockReset()
    forkMock.mockReturnValue(child.asChildProcess())
    setAiVaultServiceIdleTimeoutMs(60_000)

    const titles = resolveAiVaultSessionTitlesInService([])
    readyAiVaultServiceChild(child)
    await Promise.resolve()
    child.emit('message', {
      type: 'result',
      id: aiVaultServiceRequestId(child, 'titles'),
      operation: 'titles',
      value: { titles: [] }
    })
    await titles

    vi.advanceTimersByTime(59_999)
    expect(child.sent).not.toContainEqual({ type: 'shutdown' })
    vi.advanceTimersByTime(1)
    expect(child.sent).toContainEqual({ type: 'shutdown' })
  })
})
