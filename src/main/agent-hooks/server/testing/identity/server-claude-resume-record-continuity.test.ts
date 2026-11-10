import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
import { HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS } from '../../program-status/hook-precedence'
import { buildBody, PANE, postHookEvent } from '../server.test-fixtures'

const SESSION = '70efcb3f-ae17-4863-9318-649f5469408b'

let dir: string
let server: AgentHookServer

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-claude-continuation-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
})

afterEach(() => {
  vi.useRealTimers()
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

async function claudeHook(payload: Record<string, unknown>): Promise<void> {
  const response = await postHookEvent(server, buildBody({ session_id: SESSION, ...payload }))
  expect(response.status).toBe(204)
}

function recordedSession() {
  return server.getStatusSnapshot()[0]?.providerSession
}

function seedResume(providerSession: { cwd?: string; effort?: string }): void {
  server.recordLaunchResumeIdentity({
    paneKey: PANE,
    worktreeId: 'wt-1',
    agentType: 'claude',
    providerSession: { key: 'session_id', id: SESSION, ...providerSession },
    launchedAt: Date.now()
  })
}

it('keeps the start folder and effort when a terminal status row precedes the next hook', async () => {
  await claudeHook({ hook_event_name: 'SessionStart', source: 'startup', cwd: '/repo' })
  await claudeHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    cwd: '/repo/sub',
    effort: { level: 'max' }
  })
  await claudeHook({ hook_event_name: 'Stop', cwd: '/repo/sub', effort: { level: 'max' } })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS)
  // Claude reports OSC 7501 `working` just before UserPromptSubmit.
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    fromProgramStatus: true,
    payload: { prompt: '', state: 'working', agentType: 'claude' }
  })
  await claudeHook({ hook_event_name: 'UserPromptSubmit', prompt: 'next', cwd: '/repo/sub' })

  expect(recordedSession()).toMatchObject({ id: SESSION, cwd: '/repo', effort: 'max' })
})

it('records where a resumed process really started over the folder its seed named', async () => {
  seedResume({ cwd: '/repo' })
  await claudeHook({ hook_event_name: 'SessionStart', source: 'resume', cwd: '/elsewhere' })

  expect(recordedSession()?.cwd).toBe('/elsewhere')
})

it('names the pane session from a --fork-session start, which Claude 2.1.214+ reports as fork', async () => {
  // Captured from Claude 2.1.321 `claude --resume <id> --fork-session` before any message.
  await claudeHook({
    session_id: 'b47ec7fc-07e4-4012-8b28-1d5daa938f52',
    transcript_path:
      '/Users/u/.claude/projects/-private-tmp-w39942fork/b47ec7fc-07e4-4012-8b28-1d5daa938f52.jsonl',
    cwd: '/private/tmp/w39942fork',
    hook_event_name: 'SessionStart',
    source: 'fork'
  })

  expect(recordedSession()).toMatchObject({
    id: 'b47ec7fc-07e4-4012-8b28-1d5daa938f52',
    cwd: '/private/tmp/w39942fork'
  })
})
