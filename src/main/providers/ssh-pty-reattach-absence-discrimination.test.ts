// Three different refusals leave `reattachSshPtySessionForSpawn` carrying the same
// `SSH_SESSION_EXPIRED` text, and only one of them observed the process. That text is therefore not
// a verdict, and a caller that tests it with `.includes()` cannot tell "the host says this PTY is
// gone" from "the PTY is fine, its source stream needs rebuilding".
//
// It matters because the callers that DO test it act destructively: `spawn-execute.ts` expires the
// lease and deletes the in-memory ownership, which between them are the client's only record that a
// remote process exists. Erase both for a live PTY and #9819's sweep finds a host-attested,
// route-less, pane-bound shell on the next connect and SIGKILLs it.
//
// So this pins the discriminator the destructive branch keys on: the type, not the message.
import { describe, expect, it, vi } from 'vitest'
import { isSshPtyAbsentFromRelayError, SSH_SESSION_EXPIRED_ERROR } from './ssh-pty-errors'
import { reattachSshPtySessionForSpawn } from './ssh-pty-session-reattach'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'

const CONNECTION = 'conn-1'
const SESSION = 'pty-1'

function reattachAgainst(attach: () => Promise<unknown>): Promise<unknown> {
  return reattachSshPtySessionForSpawn({
    mux: { request: vi.fn(attach) } as unknown as SshChannelMultiplexer,
    connectionId: CONNECTION,
    sessionId: SESSION,
    options: { cols: 80, rows: 24 },
    exitRaceTracker: {
      begin: () => 1,
      didMatchingExitArrive: () => false,
      finish: () => {}
    } as never,
    acceptLivePty: () => {}
  })
}

async function refusalFrom(attach: () => Promise<unknown>): Promise<Error> {
  try {
    await reattachAgainst(attach)
  } catch (error) {
    return error as Error
  }
  throw new Error('expected the reattach to be refused')
}

describe('an SSH reattach refusal says whether the host observed the PTY', () => {
  it('marks a relay that answered "not found" as positive evidence of absence', async () => {
    const error = await refusalFrom(async () => {
      throw new Error(`PTY "${SESSION}" not found`)
    })

    expect(error.message).toContain(SSH_SESSION_EXPIRED_ERROR)
    expect(isSshPtyAbsentFromRelayError(error)).toBe(true)
  })

  it('does not mark a restoreRequired refusal as absence, though it reads identically', async () => {
    // The PTY attached. The relay answered about it. It is running. Only the source stream could
    // not be resumed — see the `restoreRequired` carve-out in ssh-pty-errors.ts.
    const error = await refusalFrom(async () => ({
      incarnationId: '11111111-1111-4111-8111-111111111111',
      sourceRecovery: { status: 'restoreRequired', reason: 'checkpoint_unavailable' }
    }))

    expect(error.message).toContain(SSH_SESSION_EXPIRED_ERROR)
    expect(isSshPtyAbsentFromRelayError(error)).toBe(false)
  })

  it('does not mark an identity mismatch as absence either', async () => {
    // The id names a LIVE PTY that belongs to a different pane.
    const error = await refusalFrom(async () => {
      throw new Error(`PTY "${SESSION}" not found (identity mismatch)`)
    })

    expect(error.message).toContain(SSH_SESSION_EXPIRED_ERROR)
    expect(isSshPtyAbsentFromRelayError(error)).toBe(false)
  })
})
