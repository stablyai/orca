import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../../server.test-fixtures'

vi.mock('../../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

let root: string
let server: AgentHookServer

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'orca-claude-opencode-replay-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: join(root, 'orca') })
})

afterEach(() => {
  server.stop()
  rmSync(root, { recursive: true, force: true })
})

// oh-my-opencode runs ~/.claude hooks, Orca's included, for OpenCode's own tool calls (#26189).
it('does not mark an OpenCode session as Claude when OpenCode replays Claude hooks', async () => {
  const response = await postHookEvent(
    server,
    buildBody({
      session_id: 'ses_0a02f3c1bffeYk2Qm9TzV4rXwP',
      cwd: '/repo',
      permission_mode: 'bypassPermissions',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      hook_source: 'opencode-plugin'
    })
  )

  expect(response.status).toBe(204)
  expect(server.getStatusSnapshot().filter((entry) => entry.paneKey === PANE)).toEqual([])
})
