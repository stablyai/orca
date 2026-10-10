import { describe, expect, it, vi } from 'vitest'
import {
  SSH_PTY_IDENTITY_MISMATCH_ERROR,
  SSH_PTY_SOURCE_RESTORE_REQUIRED_ERROR,
  SSH_SESSION_EXPIRED_ERROR,
  isSshPtyAbsentFromRelayError
} from './ssh-pty-errors'
import { SshPtyProvider } from './ssh-pty-provider'

function providerRejectingAttachWith(error: unknown): SshPtyProvider {
  const mux = {
    request: vi.fn().mockRejectedValue(error),
    notify: vi.fn(),
    onNotification: vi.fn().mockReturnValue(vi.fn())
  }
  return new SshPtyProvider('conn-1', mux as never)
}

async function reattachRejection(error: unknown): Promise<unknown> {
  const provider = providerRejectingAttachWith(error)
  return await provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-1' }).then(
    () => undefined,
    (rejection: unknown) => rejection
  )
}

describe('SSH PTY relay absence verdict', () => {
  it('reports a relay-delivered not-found as positive absence', async () => {
    const rejection = await reattachRejection(new Error('PTY "pty-1" not found'))

    expect(isSshPtyAbsentFromRelayError(rejection)).toBe(true)
    expect((rejection as Error).message).toBe(`${SSH_SESSION_EXPIRED_ERROR}: pty-1`)
  })

  it('does not report absence when the id names a live PTY owned by another pane', async () => {
    const rejection = await reattachRejection(
      new Error('PTY "pty-1" not found (identity mismatch)')
    )

    expect(isSshPtyAbsentFromRelayError(rejection)).toBe(false)
    // Byte-identical to the pre-change message: only the class is new, so the toast humanizer,
    // both spawn-execute lease paths, and the renderer's substring checks are untouched.
    expect((rejection as Error).message).toBe(
      `${SSH_SESSION_EXPIRED_ERROR}: pty-1 ${SSH_PTY_IDENTITY_MISMATCH_ERROR}`
    )
  })

  // Loss of contact never observes the process: each of these must stay `unverifiable`.
  it.each([
    ['a lost link', 'SSH connection lost, reconnecting...'],
    ['a disposed multiplexer', 'Multiplexer disposed'],
    ['a request timeout', 'Request "pty.attach" timed out after 10000ms']
  ])('does not report absence for %s', async (_label, message) => {
    const rejection = await reattachRejection(new Error(message))

    expect(isSshPtyAbsentFromRelayError(rejection)).toBe(false)
    expect((rejection as Error).message).toBe(message)
  })

  it('does not report absence when the PTY is live but its source needs restoring', async () => {
    const mux = {
      request: vi.fn().mockResolvedValue({
        incarnationId: 'incarnation-1',
        sourceRecovery: { status: 'restoreRequired', reason: 'checkpointUnavailable' }
      }),
      notify: vi.fn(),
      onNotification: vi.fn().mockReturnValue(vi.fn())
    }
    const provider = new SshPtyProvider('conn-1', mux as never)

    const rejection = await provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-1' }).then(
      () => undefined,
      (error: unknown) => error
    )

    expect(isSshPtyAbsentFromRelayError(rejection)).toBe(false)
    // Nor may it wear the expiry token: that is what the renderer retires a pane binding on.
    expect((rejection as Error).message).not.toContain(SSH_SESSION_EXPIRED_ERROR)
    expect((rejection as Error).message).toContain(SSH_PTY_SOURCE_RESTORE_REQUIRED_ERROR)
  })
})
