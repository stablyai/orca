import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../../server.test-fixtures'

it('resolves an offline Antigravity turn after binding and resumes polling when hooks are re-enabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-agy-replay-'))
  const transcriptPath = join(dir, 'transcript.jsonl')
  writeFileSync(
    transcriptPath,
    '{"source":"USER_EXPLICIT","type":"USER_INPUT","content":"First task"}\n{"type":"PLANNER_RESPONSE","model":"offline-model","step_index":2}\n'
  )
  const root = { conversationId: 'root', transcriptPath, modelName: 'auto' }
  const spoolDir = join(dir, 'agent-hooks', 'spool')
  mkdirSync(spoolDir, { recursive: true })
  writeFileSync(
    join(spoolDir, 'pane-replay.jsonl'),
    `${JSON.stringify({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      source: 'antigravity',
      // ast-grep-ignore: test-no-wall-clock -- this hook must be inside the model read lease.
      receivedAt: Date.now(),
      payload: {
        ...root,
        hookEventName: 'PreInvocation',
        lastUserInput: 'First task',
        initialNumSteps: 1
      }
    })}\n`
  )
  const server = new AgentHookServer()
  try {
    await server.start({ env: 'production', userDataPath: dir })
    await vi.waitFor(() => expect(server.getStatusSnapshot()[0]?.model).toBe('offline-model'), {
      timeout: 10000
    })
    const body = buildBody(
      { ...root, lastUserInput: 'Second task', initialNumSteps: 3 },
      { hookEventName: 'PreInvocation' }
    )
    expect((await postHookEvent(server, body, '/hook/antigravity')).status).toBe(204)
    server.setStatusHooksEnabled(false)
    appendFileSync(
      transcriptPath,
      '{"type":"PLANNER_RESPONSE","model":"second-model","step_index":4}\n'
    )
    expect(server.getStatusSnapshot()[0]?.model).toBe('offline-model')
    server.setStatusHooksEnabled(true)
    await vi.waitFor(() => expect(server.getStatusSnapshot()[0]?.model).toBe('second-model'), {
      timeout: 10000
    })
    expect(server.getStatusSnapshot()[0]?.state).toBe('working')
  } finally {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
