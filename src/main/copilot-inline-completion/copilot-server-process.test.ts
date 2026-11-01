import { afterEach, describe, expect, it, vi } from 'vitest'
import { COPILOT_SERVER_COMMAND, createCopilotServerLocator } from './copilot-server-process'

afterEach(() => {
  vi.useRealTimers()
})

describe('createCopilotServerLocator', () => {
  it('resolves the server command from PATH and caches the answer briefly', async () => {
    vi.useFakeTimers()
    const resolveOnPath = vi.fn(() => Promise.resolve('/usr/local/bin/copilot-language-server'))
    const locate = createCopilotServerLocator(resolveOnPath)
    await expect(locate()).resolves.toBe('/usr/local/bin/copilot-language-server')
    await locate()
    expect(resolveOnPath).toHaveBeenCalledTimes(1)
    expect(resolveOnPath).toHaveBeenCalledWith(COPILOT_SERVER_COMMAND)
    vi.advanceTimersByTime(61_000)
    await locate()
    expect(resolveOnPath).toHaveBeenCalledTimes(2)
  })

  it('reports not installed when the lookup fails or finds nothing', async () => {
    await expect(createCopilotServerLocator(() => Promise.resolve(null))()).resolves.toBeNull()
    await expect(
      createCopilotServerLocator(() => Promise.reject(new Error('boom')))()
    ).resolves.toBeNull()
  })
})
