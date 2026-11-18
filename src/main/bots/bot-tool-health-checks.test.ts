import { describe, expect, it } from 'vitest'
import { cancelBotToolHealthChecks, sharedBotToolHealthCheck } from './bot-tool-health-checks'

describe('a bot’s server checks', () => {
  it('shares one check per bot, agent and scope, and stopping the bot aborts it', async () => {
    const signals: AbortSignal[] = []
    const run = (signal: AbortSignal) => {
      signals.push(signal)
      return new Promise<Record<string, never>>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    const first = sharedBotToolHealthCheck('bot-a', 'claude\0remote', run)
    const joined = sharedBotToolHealthCheck('bot-a', 'claude\0remote', run)
    const other = sharedBotToolHealthCheck('bot-b', 'claude\0remote', run)
    expect(signals).toHaveLength(2)

    cancelBotToolHealthChecks('bot-a')
    await expect(first).rejects.toBeDefined()
    await expect(joined).rejects.toBeDefined()
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false])

    cancelBotToolHealthChecks('bot-b')
    await expect(other).rejects.toBeDefined()
  })
})
