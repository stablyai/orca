import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { TerminalSessionOwnerUnverifiedError } from './daemon-errors'

const socketPath = join(tmpdir(), 'orca-attach-only-mocked.sock')
const tokenPath = join(tmpdir(), 'orca-attach-only-mocked.token')

describe('attach-only ownership refusal', () => {
  it('fails closed without kill when an attach-only spawn omits incarnation proof', async () => {
    const ensureConnected = vi.spyOn(DaemonClient.prototype, 'ensureConnected').mockResolvedValue()
    const request = vi.spyOn(DaemonClient.prototype, 'request').mockResolvedValueOnce({
      isNew: true,
      snapshot: null,
      pid: 4321,
      shellState: 'unsupported'
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 30 })
    try {
      await expect(
        legacy.spawn({
          cols: 80,
          rows: 24,
          sessionId: 'unfenced-legacy-session',
          attachOnly: true
        })
      ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
      expect(request.mock.calls.filter((call) => call[0] === 'kill')).toHaveLength(0)
      expect(request.mock.calls.filter((call) => call[0] === 'killOwned')).toHaveLength(0)
      expect(errorSpy).toHaveBeenCalledWith(
        '[daemon] attach-only retire skipped; no kill-owned proof',
        { protocolVersion: 30 }
      )
    } finally {
      legacy.dispose()
      errorSpy.mockRestore()
      request.mockRestore()
      ensureConnected.mockRestore()
    }
  })
})
