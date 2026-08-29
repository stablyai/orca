import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { buildBody, postHookEvent, PANE } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const TRANSCRIPT = '/tmp/claude-session.jsonl'

describe('confirming a restored Claude turn', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-restored-turn-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  async function restartWithPersistedStatus(event: {
    hookEventName: string
    agent?: 'claude' | 'codex'
    /** Rewrite the persisted row before the second server hydrates it. */
    mutatePersisted?: (entry: Record<string, unknown>) => void
  }): Promise<AgentHookServer> {
    const first = new AgentHookServer()
    await first.start({ env: 'production', userDataPath })
    await postHookEvent(
      first,
      buildBody({
        hook_event_name: event.hookEventName,
        prompt: 'still running',
        session_id: 'sess-1',
        transcript_path: TRANSCRIPT
      }),
      `/hook/${event.agent ?? 'claude'}`
    )
    first.flushStatusPersistSync()
    first.stop()

    if (event.mutatePersisted) {
      const path = join(userDataPath, 'agent-hooks', 'last-status.json')
      const file = JSON.parse(readFileSync(path, 'utf8')) as {
        entries: Record<string, Record<string, unknown>>
      }
      const entry = Object.values(file.entries)[0]
      if (!entry) {
        throw new Error('expected a persisted entry to mutate')
      }
      event.mutatePersisted(entry)
      writeFileSync(path, JSON.stringify(file))
    }

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    return server
  }

  it('hydrates a working Claude row unconfirmed, carrying the transcript that can confirm it', async () => {
    const server = await restartWithPersistedStatus({ hookEventName: 'UserPromptSubmit' })
    try {
      const row = server.getStatusSnapshot()[0]
      expect(row?.restoredUnconfirmed).toBe(true)
      expect(row?.state).toBe('working')
      expect(row?.providerSession?.transcriptPath).toBe(TRANSCRIPT)
    } finally {
      server.stop()
    }
  })

  it('does not offer terminal or non-Claude rows for confirmation', async () => {
    const done = await restartWithPersistedStatus({ hookEventName: 'Stop' })
    try {
      expect(done.confirmRestoredWorkingTurn(PANE)).toBe(false)
    } finally {
      done.stop()
    }

    const codex = await restartWithPersistedStatus({
      hookEventName: 'UserPromptSubmit',
      agent: 'codex'
    })
    try {
      expect(codex.confirmRestoredWorkingTurn(PANE)).toBe(false)
    } finally {
      codex.stop()
    }
  })

  it('re-states the row as live: flag cleared, freshness re-stamped, turn start kept', async () => {
    const server = await restartWithPersistedStatus({ hookEventName: 'UserPromptSubmit' })
    try {
      const restored = server.getStatusSnapshot()[0]
      if (!restored) {
        throw new Error('expected hydrated status')
      }
      const emitted: string[] = []
      server.setListener((entry) => {
        emitted.push(`${entry.payload.state}:${entry.restoredUnconfirmed === true}`)
      })

      expect(server.confirmRestoredWorkingTurn(PANE)).toBe(true)

      const confirmed = server.getStatusSnapshot()[0]
      expect(confirmed?.state).toBe('working')
      expect(confirmed?.restoredUnconfirmed).toBeUndefined()
      expect(confirmed?.prompt).toBe('still running')
      // Why: freshness gates read receivedAt, so an old stamp would still render as idle.
      expect(confirmed?.receivedAt).toBeGreaterThan(restored.receivedAt)
      // Why: the turn did not restart, so its elapsed timer must not either.
      expect(confirmed?.stateStartedAt).toBe(restored.stateStartedAt)
      expect(confirmed?.providerSession?.transcriptPath).toBe(TRANSCRIPT)
      // Why last(): attaching a listener replays the hydrated row first ('working:true').
      expect(emitted.at(-1)).toBe('working:false')
    } finally {
      server.stop()
    }
  })

  it('is not repeatable — a confirmed row is no longer awaiting confirmation', async () => {
    const server = await restartWithPersistedStatus({ hookEventName: 'UserPromptSubmit' })
    try {
      expect(server.confirmRestoredWorkingTurn(PANE)).toBe(true)
      expect(server.confirmRestoredWorkingTurn(PANE)).toBe(false)
    } finally {
      server.stop()
    }
  })

  it('refuses a pane whose authority was retired — every other ingress is fenced too', async () => {
    const server = await restartWithPersistedStatus({ hookEventName: 'UserPromptSubmit' })
    try {
      server.retirePaneAuthority(PANE)
      expect(server.confirmRestoredWorkingTurn(PANE)).toBe(false)
      // Retirement drops the row outright; either way the pane must not come back live.
      const row = server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)
      expect(row === undefined || row.restoredUnconfirmed === true).toBe(true)
    } finally {
      server.stop()
    }
  })

  it('keeps the persisted child-only lead boundary — it is proof, not a re-derivable decision', async () => {
    // Why it cannot be re-derived: both branches of attachClaudeChildOnlyBoundary require
    // `claudeRunningNonAgentTask === false`, and that field is omitted from the persisted shape,
    // so a hydrated row always reads `undefined`. Dropping the flag would let the next OSC ping
    // overwrite a lead row that a live child is holding working.
    const server = await restartWithPersistedStatus({
      hookEventName: 'UserPromptSubmit',
      mutatePersisted: (entry) => {
        entry.claudeLeadBoundaryChildOnly = true
      }
    })
    try {
      expect(server.confirmRestoredWorkingTurn(PANE)).toBe(true)
      expect(server.getStatusSnapshot()[0]?.restoredUnconfirmed).toBeUndefined()
      // Read it back off disk: the flag is persisted state, so that is where its loss would show.
      server.flushStatusPersistSync()
      const persisted = JSON.parse(
        readFileSync(join(userDataPath, 'agent-hooks', 'last-status.json'), 'utf8')
      ) as { entries: Record<string, { claudeLeadBoundaryChildOnly?: boolean }> }
      expect(persisted.entries[PANE]?.claudeLeadBoundaryChildOnly).toBe(true)
    } finally {
      server.stop()
    }
  })

  it('does not claim a runtime observation — a transcript must not hold the wake assertion', async () => {
    const server = await restartWithPersistedStatus({ hookEventName: 'UserPromptSubmit' })
    try {
      // Why the listener and not the snapshot: the accept path publishes before this method can
      // withdraw the claim, and the awake service caches whatever snapshot it was handed — so the
      // *last* thing listeners were told is what holds or releases the sleep assertion.
      const published: boolean[] = []
      const unsubscribe = server.subscribeStatusChanges((statuses) => {
        const row = statuses.find((entry) => entry.state === 'working')
        if (row) {
          published.push(row.observedInCurrentRuntime)
        }
      })
      try {
        expect(server.confirmRestoredWorkingTurn(PANE)).toBe(true)
        expect(published.at(-1)).toBe(false)
        expect(server.getStatusChangeSnapshot()[0]?.observedInCurrentRuntime).toBe(false)
      } finally {
        unsubscribe()
      }
    } finally {
      server.stop()
    }
  })

  it('ignores an unknown pane', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      expect(server.confirmRestoredWorkingTurn(PANE)).toBe(false)
    } finally {
      server.stop()
    }
  })
})
