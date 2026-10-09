// After an app update the previous build's relay can still run a pane's PTY, and the new relay
// answers "not found" for an id it never minted. That answer must not reach the pane as
// `SSH_SESSION_EXPIRED`: the renderer cold-restores on that token, and spawn-execute expires the
// lease, so the user's running terminal would be silently replaced by an empty shell.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { PTY_ATTACH_PROVEN_EXITED_MARKER } from '../../shared/pty-attach-absence-evidence'
import {
  isSshPtyAbsentFromRelayError,
  SSH_PTY_HELD_BY_PREVIOUS_RELAY_ERROR,
  SSH_SESSION_EXPIRED_ERROR,
  SshPtyHeldByPreviousRelayError
} from './ssh-pty-errors'

const { previousRelayMayHoldTerminals } = vi.hoisted(() => ({
  previousRelayMayHoldTerminals: vi.fn()
}))
vi.mock('../ssh/ssh-previous-relay-terminals', () => ({ previousRelayMayHoldTerminals }))

import { reattachSshPtySessionForSpawn } from './ssh-pty-session-reattach'
import { SshPtySpawnExitRaceTracker } from './ssh-pty-spawn-exit-race'

const CONNECTION = 'conn-1'
const SESSION = 'pty2:old-epoch:1'

function refusingMux(message: string): SshChannelMultiplexer {
  // Only `request` is reached on this path; the untyped base keeps the stub free of a cast.
  return Object.assign(Object.create(null), {
    request: vi.fn(async () => {
      throw new Error(message)
    })
  })
}

async function refusalFrom(message: string): Promise<Error> {
  try {
    await reattachSshPtySessionForSpawn({
      mux: refusingMux(message),
      connectionId: CONNECTION,
      sessionId: SESSION,
      options: { cols: 80, rows: 24 },
      exitRaceTracker: new SshPtySpawnExitRaceTracker(),
      acceptLivePty: () => {}
    })
  } catch (error) {
    if (error instanceof Error) {
      return error
    }
    throw error
  }
  throw new Error('expected the reattach to be refused')
}

describe('a not-found reattach while an older Orca relay is live on the host', () => {
  beforeEach(() => {
    previousRelayMayHoldTerminals.mockReset()
  })

  it('keeps the pane bound instead of reporting the session expired', async () => {
    previousRelayMayHoldTerminals.mockResolvedValue(true)

    const error = await refusalFrom(`PTY "${SESSION}" not found`)

    expect(error).toBeInstanceOf(SshPtyHeldByPreviousRelayError)
    expect(error.message).toContain(SSH_PTY_HELD_BY_PREVIOUS_RELAY_ERROR)
    expect(error.message).not.toContain(SSH_SESSION_EXPIRED_ERROR)
    expect(isSshPtyAbsentFromRelayError(error)).toBe(false)
    expect(previousRelayMayHoldTerminals).toHaveBeenCalledWith(CONNECTION)
  })

  it('reports absence as before when no older relay may hold it', async () => {
    previousRelayMayHoldTerminals.mockResolvedValue(false)

    const error = await refusalFrom(`PTY "${SESSION}" not found`)

    expect(isSshPtyAbsentFromRelayError(error)).toBe(true)
  })

  it('does not hold an id the current relay proved exited', async () => {
    previousRelayMayHoldTerminals.mockResolvedValue(true)

    const error = await refusalFrom(
      `PTY "${SESSION}" not found (${PTY_ATTACH_PROVEN_EXITED_MARKER})`
    )

    expect(isSshPtyAbsentFromRelayError(error)).toBe(true)
    expect(previousRelayMayHoldTerminals).not.toHaveBeenCalled()
  })
})
