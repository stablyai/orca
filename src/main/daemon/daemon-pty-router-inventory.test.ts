import { describe, expect, it, vi } from 'vitest'
import { createAdapter } from './daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from './daemon-pty-router'

describe('target-scoped foreground inventory', () => {
  it('discards target responses if the established owner changed while reading', async () => {
    const current = createAdapter('current', ['target'])
    const replacement = createAdapter('replacement', [])
    const router = new DaemonPtyRouter({ current, legacy: [replacement] })
    await router.listProcesses()
    vi.mocked(current.inspectProcess).mockImplementation(async () => {
      current.emitIdentityChange()
      vi.mocked(current.hasPty).mockReturnValue(false)
      vi.mocked(replacement.hasPty).mockReturnValue(true)
      return { foregroundProcess: 'claude', hasChildProcesses: true }
    })
    await expect(router.inspectProcess('target', { foregroundOnly: true })).rejects.toThrow(
      'terminal_handle_stale'
    )
  })
})
