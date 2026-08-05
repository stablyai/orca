import { describe, expect, it, vi } from 'vitest'
import { defaultCursorSidecarScanRequest } from '../../shared/cursor-sidecar-scan'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { JsonRpcErrorCode } from '../ssh/relay-protocol'
import { scanSshCursorSidecars } from './ssh-cursor-sidecar-scan'

describe('scanSshCursorSidecars', () => {
  it('uses one versioned relay request and validates the response', async () => {
    const response = {
      version: 1,
      scopeCwds: [],
      sidecars: [],
      issues: [],
      counters: {
        rootReaddir: 0,
        bucketReaddir: 0,
        fileLstat: 0,
        boundedReads: 0,
        scopeRealpath: 0,
        returnedBytes: 0,
        elapsedMs: 0
      },
      truncated: {
        scopePaths: false,
        buckets: false,
        sessionDirs: false,
        sidecarBytes: false
      }
    }
    const requestRpc = vi.fn().mockResolvedValue(response)
    const request = defaultCursorSidecarScanRequest('/home/user/.cursor/chats', [], 'linux')

    await expect(
      scanSshCursorSidecars({ request: requestRpc } as unknown as SshChannelMultiplexer, request)
    ).resolves.toEqual(response)
    expect(requestRpc).toHaveBeenCalledWith(
      'fs.scanCursorSidecars',
      request,
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
  })

  it('fails closed when an older relay lacks the scan capability', async () => {
    const requestRpc = vi.fn().mockRejectedValue(
      Object.assign(new Error('Method not found'), {
        code: JsonRpcErrorCode.MethodNotFound
      })
    )
    const request = defaultCursorSidecarScanRequest('/home/user/.cursor/chats', [], 'linux')
    await expect(
      scanSshCursorSidecars({ request: requestRpc } as unknown as SshChannelMultiplexer, request)
    ).rejects.toThrow('remote_cursor_sidecar_scan_unavailable')
  })
})
