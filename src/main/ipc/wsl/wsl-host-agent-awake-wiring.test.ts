import { describe, expect, it, vi } from 'vitest'
import { IDLE_PASSIVE_CLIENT_CAPABILITY } from '../../../shared/remote-runtime/protocol/orcad-runtime-capabilities'
import { createQuietWslHostStreamOpener } from './wsl-host-agent-awake-wiring'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

const connection = {
  endpoint: 'ws://127.0.0.1:4100',
  hostPublicKeyB64: 'k',
  credential: { deviceToken: 't' }
}

function createTransport() {
  const seen: { method?: string; streamCaps?: readonly string[] } = {}
  const transport = {
    resolve: vi.fn(async () => connection),
    subscribe: vi.fn(
      async (
        _connection: unknown,
        method: string,
        _params: unknown,
        _timeoutMs: number,
        _callbacks: unknown,
        options?: { clientCapabilities?: readonly string[] }
      ) => {
        seen.method = method
        seen.streamCaps = options?.clientCapabilities
        return { requestId: 'r', close: vi.fn(), sendBinary: () => false }
      }
    ),
    isManuallyDisconnected: () => false
  }
  return { transport, seen }
}

describe('keep-awake WSL host stream', () => {
  it('opens straight on a passive socket of its own, whatever the host version', async () => {
    const { transport, seen } = createTransport()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake fills only the fields the opener reads.
    const open = createQuietWslHostStreamOpener(transport as never)

    const stream = await open('wsl-env', { onFrame: vi.fn(), onEnd: vi.fn() })

    expect(stream).not.toBe('unsupported')
    expect(transport.subscribe).toHaveBeenCalledTimes(1)
    expect(seen.method).toBe('session.tabs.subscribeAll')
    expect(seen.streamCaps).toContain(IDLE_PASSIVE_CLIENT_CAPABILITY)
  })
})
