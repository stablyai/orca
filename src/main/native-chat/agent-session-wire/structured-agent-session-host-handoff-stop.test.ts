// The handoff's own Stop bypasses performCancel, so it has to carry the same journal-derived
// live-turn read; without it this caller silently keeps judging against the adapter's copy.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { stopNativeHandoffTurn } from './structured-agent-session-host-handoff'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: { kind: 'claude', sessionId: 'provider-session', leafUuid: null }
}

const LIFECYCLE_IDENTITY = {
  provider: 'legacy' as const,
  agent: 'claude' as const,
  sessionId: 'session-1',
  recordId: 'turn-lifecycle:turn-1'
}

let root: string | null = null
const journals = createTrackedJournalOpener()

afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

describe('stopNativeHandoffTurn', () => {
  it('judges its Stop against the turn the journal published', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-handoff-stop-'))
    const journal = await journals.open({ identity: IDENTITY, journalDir: root })
    await journal.appendItem(
      LIFECYCLE_IDENTITY,
      {
        kind: 'status',
        text: 'Agent is working…',
        turnLifecycle: { turnId: 'turn-1', state: 'running' }
      },
      { fence: 3 }
    )
    let resolveLiveTurnId: (() => string | null) | undefined
    const cancelTurn = vi.fn(
      async (input: Parameters<StructuredAgentSessionAdapter['cancelTurn']>[0]) => {
        resolveLiveTurnId = input.resolveLiveTurnId
        return { cancelled: true }
      }
    )

    const stopped = await stopNativeHandoffTurn(
      { cancelTurn },
      { journal },
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        fence: 3
      }
    )

    expect(stopped).toBe(true)
    expect(cancelTurn).toHaveBeenCalledOnce()
    expect(resolveLiveTurnId?.()).toBe('turn-1')
    // Re-read, not captured: the turn ending is what the guard has to see.
    await journal.appendItem(
      LIFECYCLE_IDENTITY,
      { kind: 'status', text: 'Done.', turnLifecycle: { turnId: 'turn-1', state: 'completed' } },
      { fence: 3 }
    )
    expect(resolveLiveTurnId?.()).toBeNull()
  })
})
