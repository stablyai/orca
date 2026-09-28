import { describe, expect, it } from 'vitest'
import { createUnavailablePtyProvider } from './unavailable-pty-provider'

describe('unavailable terminal service', () => {
  it('refuses new work without claiming existing processes exited', async () => {
    const provider = createUnavailablePtyProvider()
    await expect(provider.spawn({ cols: 80, rows: 24 })).rejects.toThrow(
      'Terminal service unavailable'
    )
    await expect(provider.listProcesses()).rejects.toThrow('Terminal service unavailable')
    await expect(provider.shutdown('existing', {})).rejects.toThrow('Terminal service unavailable')
    await expect(provider.probePtyLiveness?.('existing')).resolves.toBeNull()
    expect(provider.writeWithSettlement('existing', 'command')).toEqual({
      outcome: 'refused',
      reason: 'provider_unavailable'
    })
  })
})
