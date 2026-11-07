import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS } from './server/program-status/hook-precedence'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status/contracts/agent-status-freshness'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

let dir: string
let server: AgentHookServer

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-agy-background-command-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
})

afterEach(() => {
  vi.useRealTimers()
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

const turn = { conversationId: 'parent', lastUserInput: 'start the job' }

async function agyHook(hookEventName: string, payload: Record<string, unknown>): Promise<void> {
  const response = await postHookEvent(
    server,
    buildBody({ ...turn, ...payload }, { hookEventName }),
    '/hook/antigravity'
  )
  expect(response.status).toBe(204)
}

function programDone(): void {
  // agy's OSC 7501 says done at every turn end, including one that waits on a background command.
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    fromProgramStatus: true,
    payload: { prompt: '', state: 'done', agentType: 'antigravity' }
  })
}

const state = () => server.getStatusSnapshot()[0]?.state

it('keeps a turn waiting on a background command working past the hook-silence fallback, then bounds it', async () => {
  const command = {
    stepIdx: 2,
    toolCall: { name: 'run_command', args: { CommandLine: 'sleep 600', IsDaemon: false } }
  }
  await agyHook('PreInvocation', {})
  await agyHook('PreToolUse', command)
  await agyHook('Stop', { fullyIdle: false, terminationReason: 'NO_TOOL_CALL' })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  // agy reports this done once; only the hook-silence recheck can offer it again.
  programDone()

  vi.advanceTimersByTime(HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS + 1)
  expect(state()).toBe('working')

  vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS)
  expect(state()).toBe('done')
})
