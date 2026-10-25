import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent, RUNNING_SHELL } from './server.test-fixtures'
import { loadClaudeInterruptCapture } from './claude-terminal-interrupt-capture.test-fixture'
import { createTerminalTitleTracker } from '../../shared/terminal-output-side-effects'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

let server: AgentHookServer

beforeEach(async () => {
  _internals.resetCachesForTests()
  server = new AgentHookServer()
  await server.start({ env: 'production' })
})

afterEach(() => {
  server.stop()
  vi.restoreAllMocks()
})

async function hook(payload: Record<string, unknown>): Promise<void> {
  const response = await postHookEvent(
    server,
    buildBody({ session_id: 'capture-session', ...payload })
  )
  expect(response.status).toBe(204)
}

function title(value: string, staleWorkingTitleClear = false): void {
  server.observeClaudeTerminalEvidence(PANE, {
    kind: 'title',
    title: value,
    staleWorkingTitleClear
  })
}

function escape(): void {
  server.observeClaudeTerminalEvidence(PANE, { kind: 'input', data: '\x1b' })
}

function row() {
  return server.getStatusSnapshotForPane(PANE)[0]
}

async function startTurn(prompt = 'captured task'): Promise<void> {
  await hook({ hook_event_name: 'UserPromptSubmit', prompt })
}

describe('Claude native title confirms an Escape interruption', () => {
  it('does not settle a stale working row when /usage is dismissed at an idle prompt', async () => {
    await startTurn()
    const tracker = createTerminalTitleTracker({
      onTitle: (_normalized, raw, meta) => title(raw, meta?.staleWorkingTitleClear)
    })
    try {
      for (const event of loadClaudeInterruptCapture('idle-usage-supported')) {
        if (event.kind === 'title') {
          tracker.handleChunk(event.chunk)
        } else {
          server.observeClaudeTerminalEvidence(PANE, { kind: 'input', data: event.text })
        }
      }
      expect(row().state).toBe('working')
    } finally {
      tracker.dispose()
    }
  })

  it.each(['stream-usage-cancel-orca', 'tool-cancel-supported'])(
    'replays the real %s PTY through the title parser and canonical store',
    async (capture) => {
      const events = loadClaudeInterruptCapture(capture)
      const tracker = createTerminalTitleTracker({
        onTitle: (_normalized, raw, meta) => title(raw, meta?.staleWorkingTitleClear)
      })
      try {
        for (const event of events) {
          if (event.kind === 'title') {
            // Split frames too: the cancellation signal must survive transport chunking.
            const middle = Math.floor(event.chunk.length / 2)
            tracker.handleChunk(event.chunk.slice(0, middle))
            tracker.handleChunk(event.chunk.slice(middle))
            if (event.title.startsWith('✳') && row()?.mainAgent?.outcome === 'cancellation') {
              expect(row()).toMatchObject({ state: 'done', interrupted: true })
              expect(row().turnCompletedAt).toBeUndefined()
              return
            }
          } else {
            if (event.label === 'submit-prompt') {
              await startTurn()
              if (capture === 'tool-cancel-supported') {
                await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} })
              }
            }
            server.observeClaudeTerminalEvidence(PANE, { kind: 'input', data: event.text })
            if (event.label === 'cancel-turn' || event.label === 'cancel-tool') {
              expect(row().state).toBe('working')
            }
            if (event.label === 'dismiss-usage') {
              expect(row().state).toBe('working')
            }
          }
        }
        throw new Error('The captured cancel did not settle the canonical row')
      } finally {
        tracker.dispose()
      }
    }
  )

  it('preserves background shell work and its later drain', async () => {
    await startTurn()
    await hook({ hook_event_name: 'Stop', background_tasks: [RUNNING_SHELL] })
    await startTurn('followup')
    title('◐ Followup')
    escape()
    title('✳ Followup')
    expect(row()).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
    await startTurn('<task-notification>Background shell finished</task-notification>')
    await hook({ hook_event_name: 'Stop', background_tasks: [] })
    expect(row()).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
  })

  it('does not attribute a later idle title to an Escape that left Claude busy', async () => {
    await startTurn()
    const tracker = createTerminalTitleTracker({
      onTitle: (_normalized, raw, meta) => title(raw, meta?.staleWorkingTitleClear)
    })
    try {
      for (const event of loadClaudeInterruptCapture('stream-usage-cancel-orca')) {
        if (event.kind === 'input' && event.label === 'cancel-turn') {
          break
        }
        if (event.kind === 'title') {
          tracker.handleChunk(event.chunk)
        } else {
          server.observeClaudeTerminalEvidence(PANE, { kind: 'input', data: event.text })
        }
      }
      title('✳ 500-row markdown table')
      expect(row()).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
      expect(row().mainAgent?.outcome).not.toBe('cancellation')
    } finally {
      tracker.dispose()
    }
  })

  it.each(['new hook', 'new input', 'reset', 'missing busy title', 'synthetic idle'])(
    'rejects %s as confirmation of an old Escape',
    async (scenario) => {
      await startTurn()
      if (scenario !== 'missing busy title') {
        title('◑ Task')
      }
      escape()
      if (scenario === 'new hook') {
        await startTurn('new turn')
      }
      if (scenario === 'new input') {
        server.observeClaudeTerminalEvidence(PANE, { kind: 'input', data: 'next prompt\r' })
      }
      if (scenario === 'reset') {
        server.observeClaudeTerminalEvidence(PANE, { kind: 'reset' })
      }
      title('✳ Task', scenario === 'synthetic idle')
      expect(row().state).toBe('working')
    }
  )

  it('never adjudicates a relayed pane from client-observed input or title', () => {
    server.ingestRemote(
      {
        paneKey: PANE,
        source: 'claude',
        payload: { state: 'working', agentType: 'claude', prompt: 'remote' }
      },
      'ssh-host'
    )
    title('◐ Remote')
    escape()
    title('✳ Remote')
    expect(row().state).toBe('working')
  })
})
