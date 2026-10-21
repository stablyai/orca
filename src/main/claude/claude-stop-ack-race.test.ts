// A task that finishes on its own just as the user presses Stop keeps its own ending. The CLI
// writes the task's completion before its answer to `stop_task`, but the SDK hands Orca a control
// answer as soon as it reads it and queues every other frame, so the acknowledgement can arrive
// first. Driven through the real SDK and Orca's stream-json connection against the scripted CLI.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { createAgentChildWorkAdmission } from '../../shared/agent-status-child-work-admission'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import { reconcileAgentChildWorkEvidence } from '../../shared/agent-status-child-work-reconciliation'
import { createAgentStatusStore } from '../../shared/agent-status-store'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import { ClaudeChildWorkDecoder } from './claude-child-work-decoder'
import {
  openClaudeStreamJsonConnection,
  type ClaudeStreamJsonConnection
} from './claude-stream-json-connection'
import { stopClaudeBackgroundTasks } from './claude-structured-control-actions'
import { CLAUDE_STRUCTURED_BASE_OPTIONS } from './claude-structured-launch-resolution'
import type { ClaudeSession } from './claude-structured-session-state'

const FAKE_CLI = join(__dirname, '__fixtures__', 'claude-agent-sdk-scripted-cli.mjs')
const SESSION_ID = '5348c19f-6a54-4c2e-9c68-9c2b1a3d4e5f'
const parent = makeStructuredAgentStatusSubject(
  { executionHostId: 'local', wslDistro: null, workspaceId: 'ws-1', workspaceKind: 'folder' },
  'session-1'
)
const STARTED = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'task-1',
  tool_use_id: 'toolu_1',
  task_type: 'local_bash',
  is_backgrounded: true,
  description: 'npm test',
  session_id: SESSION_ID,
  uuid: 'started-1'
}
const COMPLETED = {
  type: 'system',
  subtype: 'task_notification',
  task_id: 'task-1',
  tool_use_id: 'toolu_1',
  status: 'completed',
  summary: 'all 12 tests passed',
  session_id: SESSION_ID,
  uuid: 'completed-1'
}

const scratch: string[] = []
const connections: ClaudeStreamJsonConnection[] = []
afterEach(async () => {
  for (const connection of connections.splice(0)) {
    await connection.close()
  }
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Streamed text the CLI wrote ahead of the completion, as while Claude is answering. */
function streamed(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
    session_id: SESSION_ID,
    uuid: `stream-${index}`
  }))
}

async function until(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !done(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(done()).toBe(true)
}

/** The task's record after the user stops it and the CLI answers behind `ahead` streamed frames
 *  and the task's own completion, all in one write. */
async function stoppedAsItCompleted(ahead: number) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-stop-ack-race-'))
  scratch.push(dir)
  const scenarioPath = join(dir, 'scenario.json')
  writeFileSync(
    scenarioPath,
    JSON.stringify({
      steps: [{ emit: STARTED }, { delayMs: 10_000 }],
      controlResponses: { stop_task: {} },
      controlResponseLeadingFrames: { stop_task: [...streamed(ahead), COMPLETED] }
    })
  )
  const decoder = new ClaudeChildWorkDecoder()
  const evidence: AgentChildWorkEvidence[] = []
  const seen: string[] = []
  const connection = await openClaudeStreamJsonConnection(
    {
      pathToClaudeCodeExecutable: FAKE_CLI,
      options: { ...CLAUDE_STRUCTURED_BASE_OPTIONS, sessionId: SESSION_ID },
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? '',
        ORCA_SDK_CONTRACT_SCENARIO_PATH: scenarioPath,
        ORCA_SDK_CONTRACT_REPORT_PATH: join(dir, 'report.json')
      }
    },
    {
      onMessage: (message) => {
        seen.push(`${String(message.type)}:${String(message.subtype ?? '')}`)
        decoder.observe(message)
        evidence.push(...decoder.drain(seen.length))
      }
    },
    spawnProcess
  )
  connections.push(connection)
  await until(() => seen.includes('system:task_started'))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a background stop reads only the session's connection and its child-work decoder.
  const session = { connection, childWork: decoder } as unknown as ClaudeSession
  await stopClaudeBackgroundTasks(session, 5_000, () => true, ['task-1'])
  evidence.push(...decoder.drain(seen.length))
  await until(() => seen.includes('system:task_notification'))

  const store = createAgentStatusStore({ epoch: 'epoch-1', mode: 'authority' })
  store.applyMutation({ parent: { subject: parent } })
  let minted = 0
  const admission = createAgentChildWorkAdmission(store, {
    mintChildWorkId: () => `child-${++minted}`
  })
  reconcileAgentChildWorkEvidence({ store, admission, parent, provider: 'claude', evidence })
  return store.getChildren(parent)
}

describe('a Stop acknowledged ahead of the task’s own earlier completion', () => {
  for (const ahead of [0, 1, 5, 50]) {
    it(`keeps the task's own outcome and summary with ${ahead} frames ahead of it`, async () => {
      expect(await stoppedAsItCompleted(ahead)).toMatchObject([
        { membership: 'settled', outcome: 'succeeded', lastMessage: 'all 12 tests passed' }
      ])
    }, 20_000)
  }
})
