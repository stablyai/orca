import { describe, expect, it, vi } from 'vitest'
import { SshPtyProvider } from './ssh-pty-provider'

describe('SSH identity-evidence notification routing', () => {
  it('namespaces admitted rows and rejects malformed batches', () => {
    const onNotification = vi.fn().mockReturnValue(vi.fn())
    const mux = {
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn(),
      onNotification,
      dispose: vi.fn(),
      isDisposed: vi.fn().mockReturnValue(false)
    }
    const provider = new SshPtyProvider('conn-1', mux as never)
    const listener = vi.fn()
    provider.onIdentityEvidence?.(listener)
    const notify = onNotification.mock.calls[0][0] as (method: string, params: unknown) => void
    const evidence = {
      verdict: 'live',
      processName: 'codex',
      authorityGeneration: 'relay-generation',
      observationEpoch: 4,
      capturedAgeMs: 0
    }
    notify('pty.identityEvidence', {
      authorityGeneration: 'relay-generation',
      observationEpoch: 4,
      rows: [{ id: 'pty-1', incarnationId: 'incarnation-1', foregroundProcessEvidence: evidence }]
    })
    expect(listener).toHaveBeenCalledWith({
      authorityGeneration: 'relay-generation',
      observationEpoch: 4,
      providerGeneration: 1,
      rows: [
        {
          id: 'ssh:conn-1@@pty-1',
          incarnationId: 'incarnation-1',
          foregroundProcessEvidence: evidence
        }
      ]
    })
    notify('pty.identityEvidence', {
      authorityGeneration: 'relay-generation',
      observationEpoch: 5,
      rows: [{ id: 'pty-1', incarnationId: '', foregroundProcessEvidence: evidence }]
    })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
