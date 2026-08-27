import { describe, expect, it, vi } from 'vitest'
import {
  SSH_PTY_IDENTITY_MISMATCH_ERROR,
  SSH_SESSION_EXPIRED_ERROR,
  isSshPtyAbsentFromRelayError
} from './ssh-pty-errors'
import { SshPtyProvider } from './ssh-pty-provider'

function providerRejectingAttach(error: unknown): SshPtyProvider {
  return new SshPtyProvider('ssh-1', {
    request: vi.fn().mockRejectedValue(error),
    notify: vi.fn(),
    onNotification: vi.fn().mockReturnValue(vi.fn())
  } as never)
}

async function spawnRejection(error: unknown): Promise<unknown> {
  return await providerRejectingAttach(error)
    .spawn({ cols: 80, rows: 24, sessionId: 'pty-1' })
    .then(
      () => undefined,
      (rejection: unknown) => rejection
    )
}

describe('SSH relay PTY absence evidence', () => {
  it('preserves a relay-delivered not-found as positive absence', async () => {
    const rejection = await spawnRejection(new Error('PTY "pty-1" not found'))

    expect(isSshPtyAbsentFromRelayError(rejection)).toBe(true)
    expect((rejection as Error).message).toBe(`${SSH_SESSION_EXPIRED_ERROR}: pty-1`)
  })

  it('does not classify a live PTY identity collision as absence', async () => {
    const rejection = await spawnRejection(new Error('PTY "pty-1" not found (identity mismatch)'))

    expect(isSshPtyAbsentFromRelayError(rejection)).toBe(false)
    expect((rejection as Error).message).toBe(
      `${SSH_SESSION_EXPIRED_ERROR}: pty-1 ${SSH_PTY_IDENTITY_MISMATCH_ERROR}`
    )
  })

  it.each([
    ['lost link', 'SSH connection lost, reconnecting...'],
    ['disposed multiplexer', 'Multiplexer disposed'],
    ['request timeout', 'Request "pty.attach" timed out after 10000ms']
  ])('does not classify %s as absence', async (_label, message) => {
    const rejection = await spawnRejection(new Error(message))

    expect(isSshPtyAbsentFromRelayError(rejection)).toBe(false)
    expect((rejection as Error).message).toBe(message)
  })
})
