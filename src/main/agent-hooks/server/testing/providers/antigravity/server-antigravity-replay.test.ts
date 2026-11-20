import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import { buildBody, PANE, postHookEvent, recentTs } from '../../server.test-fixtures'

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
  writeFileSync(
    join(spoolDir, 'pane-replay.jsonl'),
    `\n${hooks
      .map(([hookEventName, payload], index) =>
        JSON.stringify({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          source: 'antigravity',
          receivedAt: recentTs(index),
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

it('retires a subagent that ends without a hook after status hooks are turned off and on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-agy-toggle-'))
  dirs.push(dir)
  const brain = join(dir, 'brain', 'parent', '.system_generated')
  mkdirSync(join(brain, 'logs'), { recursive: true })
  mkdirSync(join(brain, 'subagents'), { recursive: true })
  const transcriptPath = join(brain, 'logs', 'transcript.jsonl')
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'start the job' })}\n`
  )
  const descriptor = (state: string) =>
    writeFileSync(
      join(brain, 'subagents', 'child.json'),
      JSON.stringify({ conversationId: 'child', state })
    )
  descriptor('SUBAGENT_STATE_ALIVE')
  const root = { conversationId: 'parent', lastUserInput: 'start the job', transcriptPath }
  const spawn = { stepIdx: 2, toolCall: { name: 'invoke_subagent', args: { Prompt: 'ls' } } }
  const server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
  try {
    for (const [hookEventName, payload] of [
      ['PreInvocation', root],
      ['PreToolUse', { ...root, ...spawn }],
      ['PreInvocation', { conversationId: 'child', lastUserInput: '' }],
      ['Stop', { ...root, fullyIdle: false }]
    ] as const) {
      const response = await postHookEvent(
        server,
        buildBody(payload, { hookEventName }),
        '/hook/antigravity'
      )
      expect(response.status).toBe(204)
    }
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      fromProgramStatus: true,
      payload: { prompt: '', state: 'done', agentType: 'antigravity' }
    })
    await vi.waitFor(
      () => expect(server.getStatusSnapshot()[0]?.subagents?.map((c) => c.id)).toEqual(['child']),
      { timeout: 10000 }
    )

    server.setStatusHooksEnabled(false)
    server.setStatusHooksEnabled(true)
    descriptor('SUBAGENT_STATE_KILLED')

    await vi.waitFor(() => expect(server.getStatusSnapshot()[0]?.state).toBe('done'), {
      timeout: 10000
    })
    expect(server.getStatusSnapshot()[0]?.subagents ?? []).toEqual([])
  } finally {
    server.stop()
  }
})
