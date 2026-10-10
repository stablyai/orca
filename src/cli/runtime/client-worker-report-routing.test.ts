import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveRemotePairing } from './runtime-remote-pairing'
import { sendWebSocketRequest } from './websocket-transport'
import { RuntimeClient } from './client'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  RUNTIME_PROTOCOL_VERSION,
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
} from '../../shared/protocol-version'

vi.mock('./runtime-remote-pairing', () => ({ resolveRemotePairing: vi.fn() }))
vi.mock('./websocket-transport', () => ({
  sendWebSocketRequest: vi.fn(),
  sendWebSocketRequestWithStatusPreflight: vi.fn()
}))
const root = mkdtempSync(join(tmpdir(), 'orca-report-routing-'))
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

const params = {
  from: 'term-worker',
  type: 'worker_done',
  subject: 'Done',
  payload: JSON.stringify({ taskId: 'task', dispatchId: 'dispatch', outcome: 'succeeded' })
}

describe('worker report recovery scope', () => {
  it('preserves paired delivery and its pinned credentials without creating an outbox', async () => {
    const pairing = {
      v: 2 as const,
      endpoint: 'ws://target:123',
      deviceToken: 'pinned-device',
      publicKeyB64: 'pinned-key'
    }
    vi.mocked(resolveRemotePairing).mockReturnValue(pairing)
    vi.mocked(sendWebSocketRequest)
      .mockResolvedValueOnce({
        id: 'status',
        ok: true,
        _meta: { runtimeId: 'target' },
        result: {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleMobileVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
          capabilities: [ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY]
        }
      })
      .mockResolvedValueOnce({
        id: 'send',
        ok: true,
        _meta: { runtimeId: 'target' },
        result: { lifecycle: { action: 'completed' } }
      })
    const client = new RuntimeClient(root, 100, null, null)
    await expect(
      client.call('orchestration.send', params, { orchestrationRequestId: 'original' })
    ).resolves.toMatchObject({ ok: true })
    expect(sendWebSocketRequest).toHaveBeenLastCalledWith(
      pairing,
      'orchestration.send',
      params,
      100,
      expect.objectContaining({ orchestrationRequestId: 'original' })
    )
    expect(existsSync(join(root, 'worker-report-outbox'))).toBe(false)
  })

  it.each(['environment', 'options'] as const)(
    'preserves structured %s caller failures without creating an outbox',
    async (source) => {
      vi.mocked(resolveRemotePairing).mockReturnValue(null)
      if (source === 'environment') {
        vi.stubEnv('ORCA_AGENT_SESSION_ID', '12345678-1234-4234-8234-123456789012')
      }
      const client = new RuntimeClient(root, 100, null, null)
      await expect(
        client.call(
          'orchestration.send',
          params,
          source === 'options'
            ? {
                orchestrationCompatibilityEvidence: {
                  agentSessionId: '12345678-1234-4234-8234-123456789012'
                }
              }
            : undefined
        )
      ).rejects.toMatchObject({ code: 'runtime_unavailable' })
      expect(existsSync(join(root, 'worker-report-outbox'))).toBe(false)
    }
  )
})

afterEach(() => rmSync(root, { recursive: true, force: true }))
