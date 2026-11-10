import { afterEach, describe, expect, it, vi } from 'vitest'
import { startOrcadPostReadyWork } from './orcad-post-ready-work'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('orcad post-ready work', () => {
  it('loads the RPC methods, then warms terminals, before the other post-ready work', async () => {
    const order: string[] = []
    await startOrcadPostReadyWork({
      warmRpcMethods: async () => {
        order.push('methods')
      },
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

    expect(order).toEqual(['methods', 'terminals', 'rules', 'speech'])
  })

  it('never rejects, and one failure does not stop the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const startSpeechWarmup = vi.fn(async () => {})

    await expect(
      startOrcadPostReadyWork({
        warmRpcMethods: () => Promise.reject(new Error('import failed')),
        warmTerminalList: () => Promise.reject(new Error('daemon gone')),
        startAgentStateRules: () => Promise.reject(new Error('no rules')),
        startSpeechWarmup
      })
    ).resolves.toBeUndefined()

    expect(startSpeechWarmup).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith('[orcad] RPC method preload failed: import failed')
    expect(warn).toHaveBeenCalledWith('[orcad] terminal warm-up failed: daemon gone')
    expect(warn).toHaveBeenCalledWith('[orcad] agent state rules did not start: no rules')
  })
})
