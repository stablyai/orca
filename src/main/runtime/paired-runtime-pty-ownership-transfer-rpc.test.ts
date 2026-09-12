import { describe, expect, it, vi } from 'vitest'
import {
  createPairedRuntimePtyOwnershipTransferRpc,
  createPairedRuntimePtyOwnershipTransferSubscription
} from './paired-runtime-pty-ownership-transfer-rpc'

function success(runtimeId: string, result: unknown = { ok: true }) {
  return { id: 'rpc-1', ok: true as const, result, _meta: { runtimeId } }
}

describe('paired-runtime PTY ownership-transfer RPC bridge', () => {
  it('forwards only read-only probes with timeout and abort signal', async () => {
    const callRuntimeEnvironment = vi.fn(async () => success('runtime-source', { probe: true }))
    const resolveEnvironment = vi.fn(() => ({ runtimeId: 'runtime-source' }))
    const bridge = createPairedRuntimePtyOwnershipTransferRpc({
      userDataPath: '/profile',
      callRuntimeEnvironment,
      resolveEnvironment,
      getTransportGeneration: () => 0
    })
    const signal = new AbortController().signal

    await expect(
      bridge(
        'environment-source',
        'pty.ownershipTransfer.preflightSource',
        { ptyId: 'terminal-1' },
        { timeoutMs: 2_000, signal }
      )
    ).resolves.toEqual({ probe: true })
    expect(callRuntimeEnvironment).toHaveBeenCalledWith(
      '/profile',
      'environment-source',
      'pty.ownershipTransfer.preflightSource',
      { ptyId: 'terminal-1' },
      2_000,
      undefined,
      undefined,
      { signal }
    )
  })

  it('rejects stale runtime responses after a pairing replacement', async () => {
    const callRuntimeEnvironment = vi.fn(async () => success('runtime-old', { probe: true }))
    const resolveEnvironment = vi
      .fn()
      .mockReturnValueOnce({ runtimeId: 'runtime-old' })
      .mockReturnValueOnce({ runtimeId: 'runtime-new' })
    const bridge = createPairedRuntimePtyOwnershipTransferRpc({
      userDataPath: '/profile',
      callRuntimeEnvironment,
      resolveEnvironment,
      getTransportGeneration: () => 0
    })

    await expect(
      bridge('environment-source', 'pty.ownershipTransfer.statusSource', {})
    ).rejects.toThrow('pty_ownership_transfer_paired_runtime_replaced')
  })

  it('rejects responses after transport replacement with the same runtime identity', async () => {
    const callRuntimeEnvironment = vi.fn(async () => success('runtime-source', { probe: true }))
    const getTransportGeneration = vi.fn().mockReturnValueOnce(4).mockReturnValueOnce(5)
    const bridge = createPairedRuntimePtyOwnershipTransferRpc({
      userDataPath: '/profile',
      callRuntimeEnvironment,
      resolveEnvironment: () => ({ runtimeId: 'runtime-source' }),
      getTransportGeneration
    })

    await expect(
      bridge('environment-source', 'pty.ownershipTransfer.statusSource', {})
    ).rejects.toThrow('pty_ownership_transfer_paired_runtime_replaced')
  })

  it('maps RPC failures with their code so mixed-version method absence can degrade safely', async () => {
    const callRuntimeEnvironment = vi.fn(async () => ({
      id: 'rpc-1',
      ok: false as const,
      error: { code: 'method_not_found', message: 'Unknown method' },
      _meta: { runtimeId: 'runtime-source' }
    }))
    const bridge = createPairedRuntimePtyOwnershipTransferRpc({
      userDataPath: '/profile',
      callRuntimeEnvironment,
      resolveEnvironment: () => ({ runtimeId: 'runtime-source' }),
      getTransportGeneration: () => 0
    })

    await expect(
      bridge('environment-source', 'pty.ownershipTransfer.statusSource', {})
    ).rejects.toMatchObject({ code: 'method_not_found', message: 'Unknown method' })
  })

  it('rejects stale RPC failures before mixed-version degradation', async () => {
    const callRuntimeEnvironment = vi.fn(async () => ({
      id: 'rpc-1',
      ok: false as const,
      error: { code: 'method_not_found', message: 'Unknown method' },
      _meta: { runtimeId: 'runtime-source' }
    }))
    const getTransportGeneration = vi.fn().mockReturnValueOnce(4).mockReturnValueOnce(5)
    const bridge = createPairedRuntimePtyOwnershipTransferRpc({
      userDataPath: '/profile',
      callRuntimeEnvironment,
      resolveEnvironment: () => ({ runtimeId: 'runtime-source' }),
      getTransportGeneration
    })

    await expect(
      bridge('environment-source', 'pty.ownershipTransfer.statusSource', {})
    ).rejects.toThrow('pty_ownership_transfer_paired_runtime_replaced')
  })

  it('rejects a response that omits the runtime identity metadata', async () => {
    const callRuntimeEnvironment = vi.fn(
      async () =>
        ({
          id: 'rpc-1',
          ok: true as const,
          result: { probe: true },
          _meta: {}
        }) as never
    )
    const bridge = createPairedRuntimePtyOwnershipTransferRpc({
      userDataPath: '/profile',
      callRuntimeEnvironment,
      resolveEnvironment: () => ({ runtimeId: 'runtime-source' }),
      getTransportGeneration: () => 0
    })

    await expect(
      bridge('environment-source', 'pty.ownershipTransfer.statusSource', {})
    ).rejects.toThrow('pty_ownership_transfer_paired_runtime_replaced')
  })

  it('maps mutating methods to the additive source-runtime namespace', async () => {
    const callRuntimeEnvironment = vi.fn(async (_userDataPath, _selector, method) =>
      success('runtime-source', { method })
    )
    const bridge = createPairedRuntimePtyOwnershipTransferRpc({
      userDataPath: '/profile',
      callRuntimeEnvironment,
      resolveEnvironment: () => ({ runtimeId: 'runtime-source' }),
      getTransportGeneration: () => 0
    })

    await expect(
      bridge('environment-source', 'pty.ownershipTransfer.prepare', {})
    ).resolves.toEqual({ method: 'pty.ownershipTransfer.prepareSource' })
    expect(callRuntimeEnvironment).toHaveBeenCalledWith(
      '/profile',
      'environment-source',
      'pty.ownershipTransfer.prepareSource',
      {},
      undefined,
      undefined,
      undefined,
      { signal: undefined }
    )
  })

  it('forwards source-grant issuance through the authenticated runtime namespace', async () => {
    const callRuntimeEnvironment = vi.fn(async (_userDataPath, _selector, method) =>
      success('runtime-source', { method })
    )
    const bridge = createPairedRuntimePtyOwnershipTransferRpc({
      userDataPath: '/profile',
      callRuntimeEnvironment,
      resolveEnvironment: () => ({ runtimeId: 'runtime-source' }),
      getTransportGeneration: () => 0
    })

    await expect(
      bridge('environment-source', 'pty.ownershipTransfer.grantSource', {
        version: 1,
        terminalId: 'terminal-1',
        destinationRuntimeId: 'runtime-destination'
      })
    ).resolves.toEqual({ method: 'pty.ownershipTransfer.grantSource' })
    expect(callRuntimeEnvironment).toHaveBeenCalledWith(
      '/profile',
      'environment-source',
      'pty.ownershipTransfer.grantSource',
      expect.objectContaining({ terminalId: 'terminal-1' }),
      undefined,
      undefined,
      undefined,
      { signal: undefined }
    )
  })

  it('rejects a stream replaced during subscription handshake', async () => {
    const close = vi.fn()
    const subscribeRuntimeEnvironment = vi.fn(async () => ({
      requestId: 'request-1',
      close,
      sendBinary: vi.fn()
    }))
    const getTransportGeneration = vi.fn().mockReturnValueOnce(7).mockReturnValueOnce(8)
    const bridge = createPairedRuntimePtyOwnershipTransferSubscription({
      userDataPath: '/profile',
      subscribeRuntimeEnvironment: subscribeRuntimeEnvironment as never,
      resolveEnvironment: () => ({ runtimeId: 'runtime-source' }),
      getTransportGeneration
    })

    await expect(
      bridge(
        'environment-source',
        'pty.ownershipTransfer.streamSource',
        {},
        { onEvent: vi.fn(), onError: vi.fn(), onClose: vi.fn() }
      )
    ).rejects.toThrow('pty_ownership_transfer_paired_runtime_replaced')
    expect(close).toHaveBeenCalledOnce()
  })
})
