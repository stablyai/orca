import { afterEach, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { AgentHookServer } from '../server/agent-hook-server'
import { selectFreshExplicitAgentStatusRow } from '../../runtime/workspaces/process-listing/runtime-hook-agent-row-selection'
import { agentHookRuntimeDeps } from './agent-hook-runtime-deps'
import { AgentStatusObservedPaneIdentities } from '../../runtime/terminal/identity/agent-status-observed-pane-identity'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

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
