import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { AgentHookServer } from '../server/agent-hook-server'
import { selectFreshExplicitAgentStatusRow } from '../../runtime/workspaces/process-listing/runtime-hook-agent-row-selection'
import { agentHookRuntimeDeps } from './agent-hook-runtime-deps'
import { AgentStatusObservedPaneIdentities } from '../../runtime/terminal/identity/agent-status-observed-pane-identity'
import { buildBody, PANE as HOOK_PANE, postHookEvent } from '../server/testing/server.test-fixtures'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../../shared/agent-status/process/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: async () => 'exited'
}))

const PANE = makePaneKey('tab-dismissed', '11111111-1111-4111-8111-111111111111')
const servers: AgentHookServer[] = []
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
})

it('keeps a dismissed running agent out of status readers', () => {
  const server = new AgentHookServer()
  servers.push(server)
  server.ingestRemote(
    {
      paneKey: PANE,
      tabId: 'tab-dismissed',
      worktreeId: 'wt-dismissed',
      source: 'claude',
      hookEventName: 'UserPromptSubmit',
      hasExplicitPrompt: true,
      providerSession: { key: 'session_id', id: 'claude-conversation' },
      payload: { agentType: 'claude', state: 'working', prompt: 'Keep going' }
    },
    null
  )
  server.dropStatusEntry(PANE)
  const rows = server.getStatusSnapshot()
  expect(rows).toMatchObject([{ paneKey: PANE, providerSessionOnly: true }])
  const deps = agentHookRuntimeDeps(server, new AgentStatusObservedPaneIdentities(), () => ({}))
  expect(deps.getAgentStatusSnapshot()).toEqual([])
  expect(
    selectFreshExplicitAgentStatusRow({ handles: [], paneKeys: [PANE], hookRows: rows })
  ).toBeNull()
})

it("lets a command mark prove an agent's exit on every host, headless included", async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-deps-mark-'))
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production', userDataPath })
  const exits: string[] = []
  server.setTerminalPaneLifecycle({
    ownsProcess: () => true,
    isStopping: () => false,
    isReversibleStop: () => false,
    isPlaced: () => true,
    agentExited: (paneKey) => exits.push(paneKey)
  })
  const agentProcess = JSON.stringify({ pid: 4001, platform: process.platform, startTime: 'b' })
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    await postHookEvent(
      server,
      buildBody({ hook_event_name: event, session_id: 'a', prompt: 'task' }, { agentProcess })
    )
  }
  const deps = agentHookRuntimeDeps(server, new AgentStatusObservedPaneIdentities(), () => ({}))
  deps.retireAgentHookCompatibilityAuthority(HOOK_PANE, { confirmedExit: true })
  await new Promise((resolve) => setImmediate(resolve))
  expect(exits).toEqual([HOOK_PANE])
  rmSync(userDataPath, { recursive: true, force: true })
})
