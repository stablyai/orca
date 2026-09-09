import { describe, expect, it, vi } from 'vitest'
import { StructuredAgentSessionRestartRestoreGate } from './structured-agent-session-restart-restore-gate'

describe('StructuredAgentSessionRestartRestoreGate', () => {
  it('runs one successful restore across concurrent and later discovery', async () => {
    const gate = new StructuredAgentSessionRestartRestoreGate()
    const restore = vi.fn(async () => undefined)

    await Promise.all([gate.run(restore), gate.run(restore), gate.run(restore)])
    await gate.run(restore)

    expect(restore).toHaveBeenCalledOnce()
  })

  it('allows a failed restore to be retried', async () => {
    const gate = new StructuredAgentSessionRestartRestoreGate()
    const restore = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('restore failed'))
      .mockResolvedValue(undefined)

    await expect(gate.run(restore)).rejects.toThrow('restore failed')
    await expect(gate.run(restore)).resolves.toBeUndefined()

    expect(restore).toHaveBeenCalledTimes(2)
  })
})
