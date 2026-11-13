import { describe, expect, it, vi } from 'vitest'
import {
  readTerminalAutoRestoreFitMs,
  saveTerminalAutoRestoreFitMs
} from './terminal-auto-restore-fit-state'

describe('terminal auto restore fit state', () => {
  it('reads a host without the setting as the default', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      id: '1',
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method' }
    })

    await expect(readTerminalAutoRestoreFitMs({ sendRequest })).resolves.toBeNull()
    await expect(saveTerminalAutoRestoreFitMs({ sendRequest }, 60_000)).resolves.toBeNull()
  })
})
