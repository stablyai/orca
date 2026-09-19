import { describe, expect, it, vi } from 'vitest'
import type { PtyOwnershipTransferExitEvent } from '../../shared/pty-ownership-transfer-control-wire'
import {
  PTY_OWNERSHIP_TRANSFER_METHODS,
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
} from '../../shared/pty-ownership-transfer-wire'
import { SshPtyProvider } from './ssh-pty-provider'

const identity = Object.freeze({
  bridgeId: 'bridge-1',
  terminalId: 'pty-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 3,
  destinationRuntimeId: 'runtime-1'
})

const capabilities = Object.freeze({
  protocolVersions: [1],
  maxReplayBytes: 1024,
  maxInputIds: 32,
  inputDeduplication: true,
  rollback: true,
  liveTransfer: true,
  destinationOutput: true,
  destinationControl: true,
  authoritativeExit: true
})

function createProvider() {
  let exitCallback: ((event: unknown) => void) | undefined
  const notify = vi.fn()
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === PTY_OWNERSHIP_TRANSFER_METHODS.input) {
      return { accepted: true, duplicate: false }
    }
    if (method === PTY_OWNERSHIP_TRANSFER_METHODS.retireInput) {
      return { retired: 1 }
    }
    if (method === PTY_OWNERSHIP_TRANSFER_METHODS.control) {
      return {
        ...identity,
        version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
        attachmentId: params.attachmentId,
        controlId: params.controlId,
        outcome: 'applied',
        duplicate: false
      }
    }
    throw new Error(`unexpected:${method}`)
  })
  const mux = {
    isDisposed: vi.fn(() => false),
    notify,
    request,
    onNotification: vi.fn(),
    onNotificationByMethod: vi.fn((_method: string, callback: (event: unknown) => void) => {
      exitCallback = callback
      return vi.fn()
    }),
    onDispose: vi.fn(() => vi.fn())
  }
  const provider = new SshPtyProvider('conn-1', mux as never, undefined, 9)
  provider.installPublishedOwnershipTransferRoute({
    ptyId: 'ssh:conn-1@@pty-1',
    identity,
    attachmentId: 'attachment-1',
    capabilities,
    providerGeneration: 9
  })
  return {
    exit: (event: PtyOwnershipTransferExitEvent) => exitCallback?.(event),
    notify,
    provider,
    request
  }
}

describe('SSH PTY published ownership-transfer route', () => {
  it('routes input and controls through the exact published attachment', async () => {
    const { notify, provider, request } = createProvider()

    await expect(
      provider.writeWithSettlement('ssh:conn-1@@pty-1', 'echo routed\n')
    ).resolves.toEqual({ outcome: 'accepted' })
    provider.resize('ssh:conn-1@@pty-1', 100, 40)
    await provider.sendSignal('ssh:conn-1@@pty-1', 'SIGINT')

    expect(request).toHaveBeenCalledWith(
      PTY_OWNERSHIP_TRANSFER_METHODS.input,
      expect.objectContaining({ ...identity, data: 'echo routed\n' }),
      undefined
    )
    expect(request).toHaveBeenCalledWith(
      PTY_OWNERSHIP_TRANSFER_METHODS.control,
      expect.objectContaining({
        ...identity,
        attachmentId: 'attachment-1',
        control: { kind: 'resize', cols: 100, rows: 40 }
      }),
      undefined
    )
    expect(request).toHaveBeenCalledWith(
      PTY_OWNERSHIP_TRANSFER_METHODS.control,
      expect.objectContaining({ control: { kind: 'sendSignal', signal: 'SIGINT' } }),
      undefined
    )
    expect(notify).not.toHaveBeenCalledWith('pty.data', expect.anything())
    expect(notify).not.toHaveBeenCalledWith('pty.resize', expect.anything())
  })

  it('keeps legacy control fenced after the exact destination exits', async () => {
    const { exit, notify, provider, request } = createProvider()
    exit({
      ...identity,
      version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
      attachmentId: 'attachment-1',
      exit: {
        verdict: 'exited',
        eventId: 'exit-1',
        observedAt: '2026-08-31T12:00:00.000Z'
      }
    })

    expect(provider.write('ssh:conn-1@@pty-1', 'must-not-fallback')).toBe(false)
    await expect(provider.clearBuffer('ssh:conn-1@@pty-1')).rejects.toThrow(
      'pty_ownership_transfer_route_unavailable'
    )
    expect(request).not.toHaveBeenCalledWith(
      PTY_OWNERSHIP_TRANSFER_METHODS.input,
      expect.anything(),
      expect.anything()
    )
    expect(notify).not.toHaveBeenCalledWith('pty.data', expect.anything())
  })

  it('exposes stable caller operation IDs and explicit input retirement', async () => {
    const { provider, request } = createProvider()

    await expect(
      provider.writeWithSettlement('ssh:conn-1@@pty-1', 'retry-safe', {
        operationId: 'caller-input-1'
      })
    ).resolves.toEqual({ outcome: 'accepted' })
    await provider.sendSignal('ssh:conn-1@@pty-1', 'SIGINT', {
      operationId: 'caller-control-1'
    })

    expect(request).toHaveBeenCalledWith(
      PTY_OWNERSHIP_TRANSFER_METHODS.input,
      expect.objectContaining({ inputId: 'caller-input-1', data: 'retry-safe' }),
      undefined
    )
    expect(request).not.toHaveBeenCalledWith(
      PTY_OWNERSHIP_TRANSFER_METHODS.retireInput,
      expect.anything(),
      expect.anything()
    )
    expect(request).toHaveBeenCalledWith(
      PTY_OWNERSHIP_TRANSFER_METHODS.control,
      expect.objectContaining({ controlId: 'caller-control-1' }),
      undefined
    )

    await expect(
      provider.retireWriteOperation('ssh:conn-1@@pty-1', 'caller-input-1')
    ).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith(
      PTY_OWNERSHIP_TRANSFER_METHODS.retireInput,
      expect.objectContaining({ inputIds: ['caller-input-1'] }),
      undefined
    )
  })

  it('rejects installation from a stale provider generation', () => {
    const { provider } = createProvider()
    expect(() =>
      provider.installPublishedOwnershipTransferRoute({
        ptyId: 'ssh:conn-1@@pty-1',
        identity,
        attachmentId: 'attachment-2',
        capabilities,
        providerGeneration: 8
      })
    ).toThrow('pty_ownership_transfer_route_identity_mismatch')
  })
})
