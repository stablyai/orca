// The fold receipt against the real CLI: a message sent while a turn runs is
// folded by the CLI into the running turn, and Orca must keep ONE turn row —
// no interrupted marking, no second bar. Runs only where a signed-in Claude CLI
// exists, like the rest of the real-CLI suite. Live sessions prove the session
// from a SessionStart hook frame BEFORE system/init arrives, which is exactly
// the path the fixture harness cannot fake end to end.

import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { CLAUDE_STRUCTURED_BASE_OPTIONS } from './claude-structured-launch-resolution'
import {
  ClaudeStructuredSessionAdapter,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-adapter'
import {
  realClaudeAuthenticated,
  realClaudeAvailable,
  realClaudeCommand,
  realClaudeLaunchHome
} from './claude-real-cli-availability-test-support'

const SESSION_ID = 'real-cli-fold'
// Pins the live proof order (SessionStart hook frame before system/init) and lets the
// Bash steps run unprompted, whatever the config dir under test configures.
const FOLD_SESSION_SETTINGS = JSON.stringify({
  hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo' }] }] },
  permissions: { allow: ['Bash(sleep:*)'] }
})

function identity(providerSessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId: SESSION_ID,
    workspaceId: 'real-cli-fold-workspace',
    hostId: 'local',
    agent: 'claude',
    providerHandle: { kind: 'claude', sessionId: providerSessionId, leafUuid: null }
  }
}

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return check()
}

describe.skipIf(!realClaudeAvailable)('Claude structured real CLI fold', () => {
  it.skipIf(!realClaudeAuthenticated)(
    'keeps one turn row when the CLI folds a mid-turn send',
    async () => {
      const providerSessionId = randomUUID()
      const { claudeConfigDir, env } = realClaudeLaunchHome()
      const cwd = await mkdtemp(join(tmpdir(), 'orca-real-fold-'))
      const events: ClaudeStructuredSessionEvent[] = []
      const turnRows: NonNullable<ReturnType<typeof readAgentJournalTurn>>[] = []
      const sink: StructuredAgentSessionEventSink = {
        appendItem: (_identity, body: AgentJournalItemBody) => {
          const turn = readAgentJournalTurn(body)
          if (turn) {
            turnRows.push(turn)
          }
        },
        appendTombstone: () => {},
        publish: () => {}
      }
      const settled = vi.fn()
      const adapter = new ClaudeStructuredSessionAdapter({
        resolveLaunch: async () => ({
          pathToClaudeCodeExecutable: realClaudeCommand,
          options: {
            ...CLAUDE_STRUCTURED_BASE_OPTIONS,
            extraArgs: {
              ...CLAUDE_STRUCTURED_BASE_OPTIONS.extraArgs,
              settings: FOLD_SESSION_SETTINGS
            },
            sessionId: providerSessionId
          },
          cwd,
          env,
          claudeConfigDir,
          providerSessionId,
          resumeLeafUuid: null,
          resumesTranscript: false,
          continuesChain: false
        }),
        onEvent: (event) => events.push(event),
        onDispatchSettledLate: settled,
        readProcessStartTime: async () => 1
      })
      try {
        await adapter.acquire({
          identity: identity(providerSessionId),
          fence: 1,
          spawnToken: 'real-cli-fold',
          events: sink
        })
        await adapter.awaitStarted(SESSION_ID)
        // Startup proved from the SessionStart hook frame, with no init yet.
        expect(
          events.some(
            (event) =>
              event.type === 'message' &&
              event.message.type === 'system' &&
              event.message.subtype === 'init'
          )
        ).toBe(false)

        await expect(
          adapter.dispatch({
            sessionId: SESSION_ID,
            clientMessageId: 'client-A',
            body: {
              kind: 'message',
              role: 'user',
              blocks: [
                {
                  type: 'text',
                  text: 'Use the Bash tool to run `sleep 8` two separate times, one call at a time, waiting for each. Then reply exactly: FIRST DONE'
                }
              ]
            },
            requestedAt: Date.now(),
            fence: 1
          })
        ).resolves.toEqual({ state: 'admitted' })

        // Wait for A's replay to open the turn, then send B mid-turn: the first
        // `sleep 8` guarantees the CLI is still inside A's request cycle.
        expect(
          await until(
            () => events.some((event) => event.type === 'message' && event.startsTurn === true),
            30_000
          )
        ).toBe(true)
        await new Promise((resolve) => setTimeout(resolve, 2_000))
        await expect(
          adapter.dispatch({
            sessionId: SESSION_ID,
            clientMessageId: 'client-B',
            body: {
              kind: 'message',
              role: 'user',
              blocks: [{ type: 'text', text: 'Also say the word banana at the end of your reply.' }]
            },
            requestedAt: Date.now(),
            fence: 1
          })
        ).resolves.toEqual({ state: 'admitted' })

        const results = () =>
          events.flatMap((event) =>
            event.type === 'message' && event.message.type === 'result' ? [event.message] : []
          )
        expect(await until(() => results().length > 0, 90_000)).toBe(true)

        // The CLI folded: one result names both sends. (If this ever reports a
        // lone send, the steer raced past the fold window — a miss, not a fold.)
        const named = results().flatMap((message) =>
          Array.isArray(message.user_message_uuids) ? [message.user_message_uuids] : []
        )
        expect(named[0]).toHaveLength(2)

        // ONE turn for the whole run: never interrupted, and B settled accepted
        // into it under its own adopted uuid.
        expect(turnRows.every((turn) => turn.state !== 'interrupted')).toBe(true)
        expect([...new Set(turnRows.map((turn) => turn.turnId))]).toHaveLength(1)
        expect(turnRows.at(-1)).toMatchObject({ state: 'completed' })
        expect(settled).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: SESSION_ID,
            clientMessageId: 'client-B',
            providerIdentity: expect.objectContaining({ provider: 'claude' })
          })
        )
      } finally {
        await adapter.closeAll()
      }
    },
    150_000
  )
})
