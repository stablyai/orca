import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import { PANE } from '../../server.test-fixtures'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('finishes a replayed run whose subagent stopped while Orca was closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-agy-replay-'))
  dirs.push(dir)
  const brain = join(dir, 'brain', 'parent', '.system_generated')
  mkdirSync(join(brain, 'logs'), { recursive: true })
  mkdirSync(join(brain, 'subagents'), { recursive: true })
  const transcriptPath = join(brain, 'logs', 'transcript.jsonl')
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'start the job' })}\n`
  )
  writeFileSync(
    join(brain, 'subagents', 'child.json'),
    JSON.stringify({ conversationId: 'child', state: 'SUBAGENT_STATE_ALIVE' })
  )
  const root = { conversationId: 'parent', lastUserInput: 'start the job', transcriptPath }
  const child = { conversationId: 'child', lastUserInput: '' }
  const spawn = { stepIdx: 2, toolCall: { name: 'invoke_subagent', args: { Prompt: 'ls' } } }
  const hooks: [string, Record<string, unknown>][] = [
    ['PreInvocation', root],
    ['PreToolUse', { ...root, ...spawn }],
    ['PreInvocation', child],
    ['Stop', { ...root, fullyIdle: false }],
    ['Stop', { ...child, fullyIdle: true }]
  ]
  const spoolDir = join(dir, 'agent-hooks', 'spool')
  mkdirSync(spoolDir, { recursive: true })
  const now = Date.now()
  writeFileSync(
    join(spoolDir, 'pane-replay.jsonl'),
    `\n${hooks
      .map(([hookEventName, payload], index) =>
        JSON.stringify({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          source: 'antigravity',
          receivedAt: now + index,
          payload: { ...payload, hookEventName }
        })
      )
      .join('\n')}\n`
  )
  const server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
  try {
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      fromProgramStatus: true,
      payload: { prompt: '', state: 'done', agentType: 'antigravity' }
    })
    await vi.waitFor(() => expect(server.getStatusSnapshot()[0]?.state).toBe('done'), {
      timeout: 10000
    })
  } finally {
    server.stop()
  }
})
