import { describe, expect, it, vi } from 'vitest'
import { sha256 } from './codex-structured-write-digest'
import { CodexStructuredWriteLeaseRegistry } from './codex-structured-write-lease-registry'
import type { CodexStructuredWriteAdmissionReceipt } from './codex-structured-write-types'

const turn = {
  sessionId: 'session-1',
  turnEpoch: 3,
  fence: 7,
  clientMessageId: 'message-1',
  requestDigest: 'a'.repeat(64),
  writableRoot: '/worktrees/bounded'
}

function receipt(handle: string): CodexStructuredWriteAdmissionReceipt {
  return {
    protocolVersion: 1,
    requestReceiptId: 'request-1',
    effectDomain: 'local_structured_write',
    sessionId: turn.sessionId,
    turnEpoch: turn.turnEpoch,
    fence: turn.fence,
    clientMessageId: turn.clientMessageId,
    threadId: 'thread-1',
    turnId: 'turn-1',
    requestDigest: turn.requestDigest,
    toolUseId: 'tool-1',
    changePlanDigest: 'b'.repeat(64),
    worktreeRoot: turn.writableRoot,
    capabilityHandleDigest: sha256(handle),
    before: [],
    admittedAtMs: 1_000
  }
}

describe('CodexStructuredWriteLeaseRegistry', () => {
  it('persists one exact admission and rejects replay', async () => {
    const persistAdmission = vi.fn(async () => {})
    const registry = new CodexStructuredWriteLeaseRegistry({
      admitTurn: () => ({ requestReceiptId: 'request-1', writableRoot: turn.writableRoot }),
      persistAdmission,
      persistOutcome: () => {},
      now: () => 1_000,
      mintCapabilityHandle: () => 'opaque-host-handle'
    })
    const grant = await registry.authorizeTurn(turn)

    await expect(
      registry.consumeLease({
        capabilityHandle: grant!.capabilityHandle,
        receipt: receipt(grant!.capabilityHandle)
      })
    ).resolves.toBeUndefined()
    expect(persistAdmission).toHaveBeenCalledOnce()
    await expect(
      registry.consumeLease({
        capabilityHandle: grant!.capabilityHandle,
        receipt: receipt(grant!.capabilityHandle)
      })
    ).rejects.toThrow('already consumed')
  })

  it.each([
    ['request', { requestDigest: 'wrong' }],
    ['client message', { clientMessageId: 'wrong-message' }],
    ['turn', { turnEpoch: 4 }],
    ['fence', { fence: 8 }],
    ['path', { worktreeRoot: '/worktrees/other' }],
    ['handle', { capabilityHandleDigest: sha256('forged') }]
  ])('consumes but refuses a capability with the wrong %s binding', async (_label, override) => {
    const persistAdmission = vi.fn(async () => {})
    const registry = new CodexStructuredWriteLeaseRegistry({
      admitTurn: () => ({ requestReceiptId: 'request-1', writableRoot: turn.writableRoot }),
      persistAdmission,
      persistOutcome: () => {},
      now: () => 1_000,
      mintCapabilityHandle: () => 'opaque-host-handle'
    })
    const grant = await registry.authorizeTurn(turn)

    await expect(
      registry.consumeLease({
        capabilityHandle: grant!.capabilityHandle,
        receipt: { ...receipt(grant!.capabilityHandle), ...override }
      })
    ).rejects.toThrow('does not match')
    expect(persistAdmission).not.toHaveBeenCalled()
  })

  it('rejects an expired capability and an admission persistence failure', async () => {
    let now = 1_000
    const handles = ['expired-host-handle', 'unavailable-host-handle']
    const registry = new CodexStructuredWriteLeaseRegistry({
      admitTurn: () => ({ requestReceiptId: 'request-1', writableRoot: turn.writableRoot }),
      persistAdmission: async () => {
        throw new Error('receipt store unavailable')
      },
      persistOutcome: () => {},
      now: () => now,
      leaseTtlMs: 10,
      mintCapabilityHandle: () => handles.shift() as string
    })
    const expired = await registry.authorizeTurn(turn)
    now = 1_011
    await expect(
      registry.consumeLease({
        capabilityHandle: expired!.capabilityHandle,
        receipt: receipt(expired!.capabilityHandle)
      })
    ).rejects.toThrow('does not match')

    now = 2_000
    const unavailable = await registry.authorizeTurn({
      ...turn,
      turnEpoch: 4,
      clientMessageId: 'message-2'
    })
    await expect(
      registry.consumeLease({
        capabilityHandle: unavailable!.capabilityHandle,
        receipt: {
          ...receipt(unavailable!.capabilityHandle),
          turnEpoch: 4,
          clientMessageId: 'message-2',
          admittedAtMs: 2_000
        }
      })
    ).rejects.toThrow('receipt store unavailable')
  })

  it('does not let a late older authorization replace a newer capability', async () => {
    const grants = [Promise.withResolvers<boolean>(), Promise.withResolvers<boolean>()]
    const handles = ['host-handle-1', 'host-handle-2']
    const registry = new CodexStructuredWriteLeaseRegistry({
      admitTurn: async ({ turnEpoch, writableRoot }) => {
        await grants[turnEpoch - 1].promise
        return { requestReceiptId: `request-${turnEpoch}`, writableRoot }
      },
      persistAdmission: () => {},
      persistOutcome: () => {},
      now: () => 1_000,
      mintCapabilityHandle: () => handles.shift() as string
    })

    const old = registry.authorizeTurn({ ...turn, turnEpoch: 1, clientMessageId: 'message-old' })
    const current = registry.authorizeTurn({
      ...turn,
      turnEpoch: 2,
      clientMessageId: 'message-current'
    })
    grants[1].resolve(true)
    await expect(current).resolves.toMatchObject({ capabilityHandle: 'host-handle-1' })
    grants[0].resolve(true)
    await expect(old).resolves.toBeNull()
  })

  it('revokes a pending authorization when its session closes', async () => {
    const decision = Promise.withResolvers<void>()
    const registry = new CodexStructuredWriteLeaseRegistry({
      admitTurn: async ({ writableRoot }) => {
        await decision.promise
        return { requestReceiptId: 'request-1', writableRoot }
      },
      persistAdmission: () => {},
      persistOutcome: () => {}
    })
    const pending = registry.authorizeTurn(turn)
    registry.revokeSession(turn.sessionId)
    decision.resolve()

    await expect(pending).resolves.toBeNull()
  })

  it('reports synchronous outcome persistence failure without throwing into product completion', async () => {
    const failure = vi.fn()
    const registry = new CodexStructuredWriteLeaseRegistry({
      admitTurn: () => ({ requestReceiptId: 'request-1', writableRoot: turn.writableRoot }),
      persistAdmission: () => {},
      persistOutcome: () => {
        throw new Error('trace sink unavailable')
      },
      onOutcomePersistenceFailure: failure
    })

    expect(() => registry.onReceipt({} as never)).not.toThrow()
    await expect.poll(() => failure).toHaveBeenCalledOnce()
  })

  it('rejects a capability handle that the host already issued', async () => {
    const registry = new CodexStructuredWriteLeaseRegistry({
      admitTurn: ({ writableRoot }) => ({ requestReceiptId: 'request-1', writableRoot }),
      persistAdmission: () => {},
      persistOutcome: () => {},
      mintCapabilityHandle: () => 'reused-handle'
    })
    const first = await registry.authorizeTurn(turn)
    await registry.consumeLease({
      capabilityHandle: first!.capabilityHandle,
      receipt: receipt(first!.capabilityHandle)
    })

    await expect(
      registry.authorizeTurn({ ...turn, turnEpoch: 4, clientMessageId: 'message-2' })
    ).rejects.toThrow('already issued')
  })

  it('does not issue a second mutation lease for a retried client message', async () => {
    const admitTurn = vi.fn(({ writableRoot }) => ({
      requestReceiptId: 'request-1',
      writableRoot
    }))
    const registry = new CodexStructuredWriteLeaseRegistry({
      admitTurn,
      persistAdmission: () => {},
      persistOutcome: () => {},
      mintCapabilityHandle: () => 'first-handle'
    })
    await expect(registry.authorizeTurn(turn)).resolves.toMatchObject({
      capabilityHandle: 'first-handle'
    })

    await expect(registry.authorizeTurn({ ...turn, turnEpoch: 4 })).resolves.toBeNull()
    expect(admitTurn).toHaveBeenCalledOnce()
  })
})
