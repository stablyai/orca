import { describe, expect, it, vi } from 'vitest'
import { SshChannelMultiplexer, type MultiplexerTransport } from './ssh-channel-multiplexer'

function transportHarness(): {
  transport: MultiplexerTransport
  settlements: ((result: { ok: true } | { ok: false; error: Error }) => void)[]
} {
  const settlements: ((result: { ok: true } | { ok: false; error: Error }) => void)[] = []
  return {
    transport: {
      write: (_data, onSettled) => {
        if (onSettled) {
          settlements.push(onSettled)
        }
      },
      supportsWriteSettlement: true,
      onData: vi.fn(),
      onClose: vi.fn()
    },
    settlements
  }
}

describe('SshChannelMultiplexer notification settlement', () => {
  it('reports publication only from the transport write callback', () => {
    const harness = transportHarness()
    const mux = new SshChannelMultiplexer(harness.transport)
    const settled = vi.fn()

    mux.notifyWithSettlement('pty.ackData', { acknowledgements: [] }, settled)
    expect(settled).not.toHaveBeenCalled()
    harness.settlements[0]({ ok: true })
    expect(settled).toHaveBeenCalledWith({ ok: true })
    mux.dispose()
  })

  it('reports a synchronous write failure without publishing success', () => {
    const error = new Error('write failed')
    const mux = new SshChannelMultiplexer({
      write: () => {
        throw error
      },
      supportsWriteSettlement: true,
      onData: vi.fn(),
      onClose: vi.fn()
    })
    const settled = vi.fn()

    mux.notifyWithSettlement('pty.ackData', { acknowledgements: [] }, settled)
    expect(settled).toHaveBeenCalledWith({ ok: false, error })
    expect(mux.isDisposed()).toBe(true)
  })

  it('settles once when a hostile transport invokes its callback and then throws', () => {
    const mux = new SshChannelMultiplexer({
      write: (_data, onSettled) => {
        onSettled?.({ ok: true })
        throw new Error('late throw')
      },
      supportsWriteSettlement: true,
      onData: vi.fn(),
      onClose: vi.fn()
    })
    const settled = vi.fn()

    mux.notifyWithSettlement('pty.ackData', { acknowledgements: [] }, settled)
    expect(settled).toHaveBeenCalledOnce()
    expect(settled).toHaveBeenCalledWith({ ok: true })
  })

  it('fails an unsettled publication when the multiplexer is disposed', () => {
    const close = vi.fn()
    const mux = new SshChannelMultiplexer({
      write: () => false,
      supportsWriteSettlement: true,
      onDrain: vi.fn(),
      onData: vi.fn(),
      onClose: vi.fn(),
      close
    })
    const settled = vi.fn()

    mux.notifyWithSettlement('pty.ackData', { acknowledgements: [] }, settled)
    expect(settled).not.toHaveBeenCalled()
    mux.dispose()

    expect(settled).toHaveBeenCalledWith({
      ok: false,
      error: expect.objectContaining({ code: 'DISPOSED' })
    })
    expect(close).toHaveBeenCalledOnce()
  })
})
