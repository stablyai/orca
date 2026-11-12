import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createProgramStatusProjector } from '../../../../../shared/program-status/agent-status-projector'
import { AgentHookServer } from '../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../server.test-fixtures'

const SESSION = 'sess_11111111-2222-4333-8444-555555555555'

// Shape written by kiro-cli 3.1.0's TUI, which reports under its binary name.
const kiroOsc = (state: string): string => `\x1b]7501;state=${state}:app=kiro-cli\x07`

let dir: string
let server: AgentHookServer
let projector: ReturnType<typeof createProgramStatusProjector>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-kiro-program-status-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
  projector = createProgramStatusProjector()
})

afterEach(() => {
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

async function kiroHook(hookEventName: string, payload: Record<string, unknown> = {}) {
  const response = await postHookEvent(
    server,
    buildBody({ session_id: SESSION, hook_event_name: hookEventName, cwd: '/repo', ...payload }),
    '/hook/kiro'
  )
  expect(response.status).toBe(204)
}

function kiroReports(state: string): void {
  for (const { payload } of projector.process(kiroOsc(state)).payloads) {
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      fromProgramStatus: true,
      payload
    })
  }
}

function recordedRow() {
  const row = server.getStatusSnapshot()[0]
  return { agentType: row?.agentType, sessionId: row?.providerSession?.id }
}

it('keeps the Kiro session through a turn that Kiro also reports over OSC 7501', async () => {
  kiroReports('working')
  await kiroHook('UserPromptSubmit', { prompt: 'hi' })
  await kiroHook('Stop')
  kiroReports('done')

  expect(recordedRow()).toEqual({ agentType: 'kiro', sessionId: SESSION })
})
