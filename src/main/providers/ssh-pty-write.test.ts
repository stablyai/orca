import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshPtyProvider } from './ssh-pty-provider'
import { SSH_PTY_WRITE_SETTLEMENT_TIMEOUT_MS } from './ssh-pty-write'
import {
  MULTIPLEXER_ORDINARY_QUEUE_MAX_BYTES,
  type MultiplexerWriteSettlement
} from '../ssh/ssh-multiplexer-transport-writer'

describe('SSH PTY writes', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects writes synchronously after the transport is disposed', () => {
    const mux = {
      isDisposed: vi.fn().mockReturnValue(true),
      notify: vi.fn(),
      onNotification: vi.fn()
    }
    const provider = new SshPtyProvider('conn-1', mux as never)

    expect(provider.write('ssh:conn-1@@pty-1', 'pointer')).toBe(false)
    expect(mux.notify).not.toHaveBeenCalled()
  })

  it('reports a failed transport settlement instead of enqueue acceptance', async () => {
    let settle: ((result: MultiplexerWriteSettlement) => void) | undefined
    const mux = {
      isDisposed: vi.fn().mockReturnValue(false),
      notify: vi.fn(),
      notifyWithSettlement: vi.fn((_method, _params, onSettled) => {
        settle = onSettled
      }),
      onNotification: vi.fn()
    }
    const provider = new SshPtyProvider('conn-1', mux as never)

    const pending = provider.writeWithSettlement('ssh:conn-1@@pty-1', 'pointer')
    expect(mux.notifyWithSettlement).toHaveBeenCalledWith(
      'pty.data',
      { id: 'pty-1', data: 'pointer' },
      expect.any(Function)
    )
    settle?.({
      outcome: 'refused',
      reason: 'transport_rejected_before_handoff',
      error: new Error('transport rejected write')
    })

    await expect(pending).resolves.toEqual({
      outcome: 'refused',
      reason: 'transport_rejected_before_handoff'
    })
  })

  it('rejects an atomic write that cannot fit in one ordinary relay frame', () => {
    const mux = {
      isDisposed: vi.fn().mockReturnValue(false),
      notify: vi.fn(),
      onNotification: vi.fn()
    }
    const provider = new SshPtyProvider('conn-1', mux as never)

    expect(
      provider.write('ssh:conn-1@@pty-1', 'x'.repeat(MULTIPLEXER_ORDINARY_QUEUE_MAX_BYTES))
    ).toBe(false)
    expect(mux.notify).not.toHaveBeenCalled()
  })

  it('rejects an oversized settled write before touching the mux', async () => {
    const mux = {
      isDisposed: vi.fn().mockReturnValue(false),
      notifyWithSettlement: vi.fn(),
      onNotification: vi.fn()
    }
    const provider = new SshPtyProvider('conn-1', mux as never)

    await expect(
      provider.writeWithSettlement(
        'ssh:conn-1@@pty-1',
        'x'.repeat(MULTIPLEXER_ORDINARY_QUEUE_MAX_BYTES)
      )
    ).resolves.toEqual({ outcome: 'refused', reason: 'payload_exceeds_transport_limit' })
    expect(mux.notifyWithSettlement).not.toHaveBeenCalled()
  })

  it('rejects settled writes immediately after the transport is disposed', async () => {
    const mux = {
      isDisposed: vi.fn().mockReturnValue(true),
      notifyWithSettlement: vi.fn(),
      onNotification: vi.fn(),
      dispose: vi.fn()
    }
    const provider = new SshPtyProvider('conn-1', mux as never)

    await expect(provider.writeWithSettlement('ssh:conn-1@@pty-1', 'pointer')).resolves.toEqual({
      outcome: 'refused',
      reason: 'transport_disposed'
    })
    expect(mux.notifyWithSettlement).not.toHaveBeenCalled()
    expect(mux.dispose).not.toHaveBeenCalled()
  })

  it('reports a lost settlement as unverifiable, never as a proven refusal', async () => {
    vi.useFakeTimers()
    const mux = {
      isDisposed: vi.fn().mockReturnValue(false),
      notify: vi.fn(),
      notifyWithSettlement: vi.fn(),
      onNotification: vi.fn(),
      dispose: vi.fn()
    }
    const provider = new SshPtyProvider('conn-1', mux as never)
    const pending = provider.writeWithSettlement('ssh:conn-1@@pty-1', 'pointer')

    const settled = expect(pending).resolves.toEqual({
      outcome: 'unverifiable',
      reason: 'settlement_timeout',
      bytesHandedToTransport: true
    })
    await vi.advanceTimersByTimeAsync(SSH_PTY_WRITE_SETTLEMENT_TIMEOUT_MS - 1)
    expect(mux.dispose).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    await settled
    expect(mux.dispose).toHaveBeenCalledWith('connection_lost')
  })

  it('accepts a healthy settlement after the mux health window', async () => {
    vi.useFakeTimers()
    let settle: ((result: MultiplexerWriteSettlement) => void) | undefined
    const mux = {
      isDisposed: vi.fn().mockReturnValue(false),
      notify: vi.fn(),
      notifyWithSettlement: vi.fn(
        (
          _method: string,
          _params: unknown,
          callback: (result: MultiplexerWriteSettlement) => void
        ) => {
          settle = callback
        }
      ),
      onNotification: vi.fn(),
      dispose: vi.fn()
    }
    const provider = new SshPtyProvider('conn-1', mux as never)
    const pending = provider.writeWithSettlement('ssh:conn-1@@pty-1', 'pointer')

    await vi.advanceTimersByTimeAsync(SSH_PTY_WRITE_SETTLEMENT_TIMEOUT_MS - 1)
    settle?.({ outcome: 'accepted' })

    await expect(pending).resolves.toEqual({ outcome: 'accepted' })
    expect(mux.dispose).not.toHaveBeenCalled()
  })
})
