/**
 * Regression: pruneDisconnectedPtyTranscript empties a disconnected PTY's
 * retained tail. The onPtyData wait-scan memoization caches the tail's wait
 * state on the record (tailWaitState) and reuses it as the next chunk's
 * "previous" state — so the prune MUST also clear that cache, or a record that
 * resumes output after adoption/reattach would reuse a stale (pre-prune,
 * possibly blocked) wait state and mis-stamp waitBlockedAt on its first chunk.
 */
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { TerminalTailWaitState } from './orca-runtime'

type PtyRecord = {
  connected: boolean
  tailBuffer: string[]
  tailWaitState?: TerminalTailWaitState
}
type RuntimeInternals = {
  recordPtyWorktree: (p: string, w: string, s?: { connected?: boolean }) => PtyRecord
  pruneDisconnectedPtyTranscript: (pty: PtyRecord) => void
}

describe('pruneDisconnectedPtyTranscript clears the wait-scan cache', () => {
  it('empties the tail and drops tailWaitState so resume recomputes', () => {
    const runtime = new OrcaRuntimeService()
    const internals = runtime as unknown as RuntimeInternals
    const pty = internals.recordPtyWorktree('pty-1', 'wt-1', { connected: true })

    // Simulate an established, blocked tail with a memoized wait state.
    pty.tailBuffer = ['Update available! Press Enter to continue.']
    pty.tailWaitState = {
      waitText: 'update available! press enter to continue.',
      signal: { reason: 'codex-update-prompt', index: 0 },
      usageLimitSignal: null,
      fromTail: true
    }

    pty.connected = false
    internals.pruneDisconnectedPtyTranscript(pty)

    expect(pty.tailBuffer).toEqual([])
    expect(pty.tailWaitState).toBeUndefined()
  })
})
