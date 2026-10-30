import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { CLAUDE_STRUCTURED_BASE_OPTIONS } from './claude-structured-launch-resolution'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import type { ClaudeStructuredSessionEvent } from './structured/claude-structured-session-state'
import {
  realClaudeAuthenticated,
  realClaudeAvailable,
  realClaudeCommand,
  realClaudeLaunchHome
} from './claude-real-cli-availability-test-support'
import { claudeStartupSettled } from './claude-structured-startup-settled-test-support'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'

const SESSION_ID = 'real-cli-stop-task'
const SETTINGS = JSON.stringify({ permissions: { allow: ['Bash(sleep:*)'] } })

function identity(providerSessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId: SESSION_ID,
    workspaceId: 'real-cli-stop-task-workspace',
    hostId: 'local',
    agent: 'claude',
    providerHandle: claudeProviderHandle(providerSessionId, null)
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

function taskFrames(events: readonly ClaudeStructuredSessionEvent[], taskId: string) {
  return events.flatMap((event) =>
    event.type === 'message' &&
    event.message.type === 'system' &&
    typeof event.message.subtype === 'string' &&
    event.message.subtype.startsWith('task_') &&
    event.message.task_id === taskId
      ? [event.message]
      : []
  )
}

describe.skipIf(!realClaudeAvailable)('Claude structured real CLI targeted stop', () => {
  it.skipIf(!realClaudeAuthenticated)(
    'acknowledges stop_task on one live background agent',
    async () => {
      const providerSessionId = randomUUID()
      const { claudeConfigDir, env } = realClaudeLaunchHome()
      const cwd = await mkdtemp(join(tmpdir(), 'orca-real-stop-task-'))
      const events: ClaudeStructuredSessionEvent[] = []
      const sink: StructuredAgentSessionEventSink = {
        appendItem: () => {},
        appendTombstone: () => {},
        publish: () => {}
      }
      const adapter = new ClaudeStructuredSessionAdapter({
        resolveLaunch: async () => ({
          pathToClaudeCodeExecutable: realClaudeCommand,
          options: {
            ...CLAUDE_STRUCTURED_BASE_OPTIONS,
            extraArgs: { ...CLAUDE_STRUCTURED_BASE_OPTIONS.extraArgs, settings: SETTINGS },
            sessionId: providerSessionId
          },
          cwd,
          env,
          claudeConfigDir,
          providerSessionId,
          resumeLeafUuid: null,
          resumesTranscript: false,
          cliFlag: async () => 'supported' as const,
          continuesChain: false
        }),
        onEvent: (event) => events.push(event),
        readProcessStartTime: async () => 1
      })
      try {
        await adapter.acquire({
          identity: identity(providerSessionId),
          fence: 1,
          spawnToken: 'real-cli-stop-task',
          events: sink
        })
        await claudeStartupSettled(adapter, SESSION_ID)
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
                  text: 'Use the Agent tool once, with run_in_background set to true and description "Sleeper", asking the subagent to run `sleep 120` with the Bash tool. Do not wait for it. Then reply exactly: LAUNCHED'
                }
              ]
            },
            requestedAt: Date.now(),
            fence: 1
          })
        ).resolves.toMatchObject({ state: 'admitted' })

        const started = () =>
          events.flatMap((event) =>
            event.type === 'message' &&
            event.message.type === 'system' &&
            event.message.subtype === 'task_started' &&
            event.message.task_type === 'local_agent' &&
            typeof event.message.task_id === 'string'
              ? [event.message.task_id]
              : []
          )
        expect(await until(() => started().length > 0, 90_000)).toBe(true)
        const [taskId] = started()
        // Give the subagent time to reach its sleep, so the stop lands on a live run.
        await new Promise((resolve) => setTimeout(resolve, 5_000))

        const acknowledged: unknown[] = []
        const outcome = await adapter.stopBackgroundTasks({
          sessionId: SESSION_ID,
          fence: 1,
          taskIds: [taskId],
          acknowledge: (acknowledgement) => void acknowledged.push(acknowledgement)
        })
        expect(outcome).toMatchObject({ cancelled: true })
        expect(acknowledged).toEqual([{ taskId }])

        const ended = await until(
          () =>
            taskFrames(events, taskId).some(
              (frame) =>
                frame.subtype === 'task_notification' ||
                (frame.subtype === 'task_updated' &&
                  typeof frame.patch === 'object' &&
                  frame.patch !== null &&
                  'status' in frame.patch)
            ),
          30_000
        )
        expect(ended).toBe(true)
        const frames = taskFrames(events, taskId).map((frame) => ({
          subtype: frame.subtype,
          status:
            frame.status ??
            (typeof frame.patch === 'object' && frame.patch !== null && 'status' in frame.patch
              ? frame.patch.status
              : undefined)
        }))
        console.info('[real-cli stop_task] task frames', JSON.stringify(frames))
        const endings = frames.filter((frame) => frame.status !== undefined)
        expect(endings.length).toBeGreaterThan(0)
        expect(
          endings.every((frame) =>
            ['stopped', 'killed', 'cancelled'].includes(String(frame.status))
          )
        ).toBe(true)
      } finally {
        await adapter.closeAll()
      }
    },
    180_000
  )
})
