import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, GOOD_PANE, PANE, postHookEvent } from './server.test-fixtures'
import { ClaudeObservedConfigDirs } from '../claude-accounts/claude-observed-config-dirs'
import { installClaudeObservedConfigDirs } from '../claude-accounts/claude-profile-installed-router'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../shared/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: async () => 'live'
}))

let root: string | undefined
let server: AgentHookServer | undefined
afterEach(() => {
  server?.stop()
  installClaudeObservedConfigDirs(undefined)
  if (root) {
    rmSync(root, { recursive: true, force: true })
  }
})

it('records the Claude config folder from Claude hooks only, not same-layout CodeBuddy hooks', async () => {
  root = mkdtempSync(join(tmpdir(), 'orca-claude-observed-'))
  const transcript = (home: string) => {
    mkdirSync(join(root!, home, 'projects', '-repo'), { recursive: true })
    return join(root!, home, 'projects', '-repo', 'id.jsonl')
  }
  const dirs = new ClaudeObservedConfigDirs(join(root, 'observed.json'), () => ({}))
  installClaudeObservedConfigDirs(dirs)
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: join(root, 'orca') })
  const post = (path: string, transcriptPath: string, paneKey = PANE) =>
    postHookEvent(
      server!,
      buildBody(
        {
          hook_event_name: 'UserPromptSubmit',
          session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          transcript_path: transcriptPath,
          prompt: 'hi'
        },
        {
          paneKey,
          tabId: paneKey.split(':')[0],
          agentProcess: JSON.stringify({ pid: 4001, platform: process.platform, startTime: 'x' })
        }
      ),
      path
    )
  await post('/hook/claude', transcript('.claude-work'))
  // Separate pane: one pane's claim does not depend on the other agent's.
  await post('/hook/codebuddy', transcript('.codebuddy'), GOOD_PANE)
  expect(dirs.list()).toEqual([join(root, '.claude-work')])
})
