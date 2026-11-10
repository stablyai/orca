import { afterEach, describe, expect, it, vi } from 'vitest'
import { startOrcadPostReadyWork } from './orcad-post-ready-work'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('orcad post-ready work', () => {
  it('starts the terminal warm-up before the other post-ready work', async () => {
    const order: string[] = []
    await startOrcadPostReadyWork({
      warmTerminalList: async () => {
        order.push('terminals')
      },
      startAgentStateRules: async () => {
        order.push('rules')
      },
      startSpeechWarmup: async () => {
        order.push('speech')
      }
    })

    expect(order).toEqual(['terminals', 'rules', 'speech'])
  })

  it('never rejects, and one failure does not stop the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const startSpeechWarmup = vi.fn(async () => {})

    await expect(
      startOrcadPostReadyWork({
        warmTerminalList: () => Promise.reject(new Error('daemon gone')),
        startAgentStateRules: () => Promise.reject(new Error('no rules')),
        startSpeechWarmup
      })
    ).resolves.toBeUndefined()

    expect(startSpeechWarmup).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith('[orcad] terminal warm-up failed: daemon gone')
    expect(warn).toHaveBeenCalledWith('[orcad] agent state rules did not start: no rules')
  })
})
