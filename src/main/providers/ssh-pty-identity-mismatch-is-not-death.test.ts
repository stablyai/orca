/**
 * An identity mismatch means the relay FOUND the PTY and its recorded pane
 * differs — the shell is running. Publishing that as expiry makes the renderer
 * clear the binding and cold-restore with agent resume, which is a second agent
 * on one transcript while the first keeps running.
 *
 * Reachable today from a shipped gesture: detaching a pane into a new tab
 * changes tabId, the relay still holds the tabId frozen at spawn, and the
 * reattach mismatches.
 *
 * Pins the PRODUCER and the CONSUMERS together. The two guards this program
 * shipped before both passed while sitting off the route production takes, so
 * asserting the classifier alone is not enough — the destructive token has to
 * be absent from what the reattach actually throws.
 */
import { describe, expect, it, vi } from 'vitest'
import { reattachSshPtySession } from './ssh-pty-session-reattach'
import {
  SSH_SESSION_EXPIRED_ERROR,
  SSH_PTY_IDENTITY_MISMATCH_ERROR,
  formatPtyExitedError
} from '../../shared/ssh-pty-failure-tokens'

/** The renderer converts a failure into `sessionExpired: true` on these tokens
 *  and then respawns on the flag alone, never consulting the classifier.
 *  Mirrors pty-transport.ts. */
const SSH_PTY_CONNECTION_MISMATCH_MARKER = 'belongs to SSH connection'
function transportWouldReportSessionExpired(message: string): boolean {
  return (
    message.includes(SSH_SESSION_EXPIRED_ERROR) ||
    message.includes(SSH_PTY_CONNECTION_MISMATCH_MARKER)
  )
}

const CONNECTION_ID = 'ssh-target-1'
const RELAY_PTY_ID = 'pty-7'

function muxThatFailsAttachWith(message: string): { mux: unknown } {
  return {
    mux: {
      request: vi.fn().mockRejectedValue(new Error(message)),
      notify: vi.fn()
    }
  }
}

async function reattachError(
  attachFailure: string,
  expectedIncarnationId?: string
): Promise<Error> {
  const { mux } = muxThatFailsAttachWith(attachFailure)
  try {
    await reattachSshPtySession({
      mux: mux as never,
      connectionId: CONNECTION_ID,
      sessionId: RELAY_PTY_ID,
      options: {
        cols: 80,
        rows: 24,
        paneKey: 'tab-new:leaf-1',
        tabId: 'tab-new',
        ...(expectedIncarnationId ? { expectedIncarnationId } : {})
      } as never
    })
  } catch (error) {
    return error as Error
  }
  throw new Error('reattach unexpectedly succeeded')
}

describe('an identity mismatch is not a death', () => {
  it('does not publish the destructive expiry token', async () => {
    const error = await reattachError(`PTY "${RELAY_PTY_ID}" not found (identity mismatch)`)

    expect(error.message).not.toContain(SSH_SESSION_EXPIRED_ERROR)
  })

  // The renderer keys off this token; its own clauses live beside the
  // classifier, in reattach-failure-classification.test.ts.
  it('marks the failure with the shared mismatch token', async () => {
    const error = await reattachError(`PTY "${RELAY_PTY_ID}" not found (identity mismatch)`)

    expect(error.message).toContain(SSH_PTY_IDENTITY_MISMATCH_ERROR)
  })

  // The flag path bypasses the classifier entirely, so it needs its own clause.
  it('does not trip the renderer transport into sessionExpired', async () => {
    const error = await reattachError(`PTY "${RELAY_PTY_ID}" not found (identity mismatch)`)

    expect(transportWouldReportSessionExpired(error.message)).toBe(false)
  })
})

describe('only an exit the relay watched is a death', () => {
  // Clause-selectivity: a fix that silences real expiry would strand panes on a
  // shell that truly went away, so the contrast has to hold.
  it('publishes expiry when the relay reports the exit it observed', async () => {
    const error = await reattachError(
      formatPtyExitedError(RELAY_PTY_ID, 0, 'inc-host-7'),
      'inc-host-7'
    )

    expect(error.message).toContain(SSH_SESSION_EXPIRED_ERROR)
    expect(error.message).not.toContain(SSH_PTY_IDENTITY_MISMATCH_ERROR)
    expect(transportWouldReportSessionExpired(error.message)).toBe(true)
  })

  // INVERTED. This used to require a bare absence to publish expiry. That is the defect: the relay
  // we asked cannot hand the id back, which proves an exit ONLY if it is the relay that minted it.
  // A replaced relay answers exactly this for shells still running under its predecessor, so
  // expiry there cleared ownership and resumed the agent a second time onto a live shell. The
  // death that is real is still detected — by the clause above, from an exit the relay watched.
  // Enforcement cannot live only on the host: the host is the party whose answer is in question,
  // and versions differ. A proof we cannot tie to the shell we asked about is not proof.
  it('does not publish expiry for an exit that names a different shell', async () => {
    const error = await reattachError(
      formatPtyExitedError(RELAY_PTY_ID, 0, 'inc-some-other-shell'),
      'inc-host-7'
    )

    expect(error.message).not.toContain(SSH_SESSION_EXPIRED_ERROR)
    expect(transportWouldReportSessionExpired(error.message)).toBe(false)
  })

  it('does not publish expiry for an exit that names a different PTY id', async () => {
    const error = await reattachError(
      formatPtyExitedError('pty-some-other-shell', 0, 'inc-host-7'),
      'inc-host-7'
    )

    expect(error.message).not.toContain(SSH_SESSION_EXPIRED_ERROR)
    expect(transportWouldReportSessionExpired(error.message)).toBe(false)
  })

  it('does not publish expiry for an exit when the pane knows no incarnation', async () => {
    const error = await reattachError(formatPtyExitedError(RELAY_PTY_ID, 0, 'inc-host-7'))

    expect(error.message).not.toContain(SSH_SESSION_EXPIRED_ERROR)
  })

  it('does not publish expiry when the relay merely has no such PTY', async () => {
    const error = await reattachError(`PTY "${RELAY_PTY_ID}" not found`)

    expect(error.message).not.toContain(SSH_SESSION_EXPIRED_ERROR)
    expect(transportWouldReportSessionExpired(error.message)).toBe(false)
  })

  it('leaves an unrelated failure untouched rather than guessing', async () => {
    const error = await reattachError('ECONNRESET while writing to the relay')

    expect(error.message).not.toContain(SSH_SESSION_EXPIRED_ERROR)
    expect(error.message).not.toContain(SSH_PTY_IDENTITY_MISMATCH_ERROR)
  })
})

// New relays prioritize incarnation, so the pane fields do not reject a moved pane. Old relays
// ignore the additive incarnation field and still need their weaker pane fence.
describe('reattach preserves the old-relay pane fence', () => {
  async function attachParams(
    extraOptions: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const request = vi.fn().mockRejectedValue(new Error('boom'))
    try {
      await reattachSshPtySession({
        mux: { request, notify: vi.fn() } as never,
        connectionId: CONNECTION_ID,
        sessionId: RELAY_PTY_ID,
        options: {
          cols: 80,
          rows: 24,
          paneKey: 'tab-new:leaf-1',
          tabId: 'tab-new',
          env: { ORCA_PANE_KEY: 'tab-old:leaf-1', ORCA_TAB_ID: 'tab-old' },
          ...extraOptions
        } as never
      })
    } catch {
      // the attach failure is not what this clause is about
    }
    const call = request.mock.calls.at(0)
    return (call?.[1] ?? call?.[0] ?? {}) as Record<string, unknown>
  }

  it('sends the current pane key for relays that do not understand incarnation', async () => {
    expect(await attachParams()).toMatchObject({ expectedPaneKey: 'tab-new:leaf-1' })
  })

  it('sends the current tab id for relays that do not understand incarnation', async () => {
    expect(await attachParams()).toMatchObject({ expectedTabId: 'tab-new' })
  })

  // The producer pin for the relay's incarnation guard. The guard is only worth having if the
  // expectation actually leaves the client, and nothing else here would notice if it stopped:
  // the relay stays permissive on an absent field, so a silent regression reads as "all green".
  it('sends the expected incarnation when the host attested one', async () => {
    expect(await attachParams({ expectedIncarnationId: 'inc-host-7' })).toMatchObject({
      expectedIncarnationId: 'inc-host-7',
      expectedPaneKey: 'tab-new:leaf-1',
      expectedTabId: 'tab-new'
    })
  })

  // A stand-in minted locally when the host reported none. It is first-write-wins and is dropped
  // when provider state resets, so the same live shell can present a different one after a
  // reconnect — sending it would make the relay refuse the pane its own shell.
  it('sends no expected incarnation when the value was synthesized locally', async () => {
    expect(await attachParams({ expectedIncarnationId: 'legacy:23:0:pty-7' })).not.toHaveProperty(
      'expectedIncarnationId'
    )
  })

  it('sends no expected incarnation when there is none to send', async () => {
    expect(await attachParams()).not.toHaveProperty('expectedIncarnationId')
  })
})
