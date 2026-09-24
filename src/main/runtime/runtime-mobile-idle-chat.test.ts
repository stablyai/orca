import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusIpcPayload
} from '../../shared/agent-status-types'
import type { RuntimeMobileSessionTerminalTab } from '../../shared/runtime-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import { OrcaRuntimeService } from './orca-runtime'

const TAB_ID = 'idle-chat-tab'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const PTY_ID = 'idle-chat-pty'
const WORKSPACE = 'folder-workspace'
const SESSION = {
  key: 'session_id' as const,
  id: 'codex-session',
  transcriptPath: '/sessions/codex.jsonl'
}
const TAB: RuntimeMobileSessionTerminalTab = {
  type: 'terminal',
  id: `${TAB_ID}::${LEAF_ID}`,
  parentTabId: TAB_ID,
  leafId: LEAF_ID,
  ptyId: PTY_ID,
  title: 'Terminal',
  isActive: true
}

class IdleChatRuntime extends OrcaRuntimeService {
  project(tab = TAB) {
    return this.toMobileSessionTabsResult({
      worktree: WORKSPACE,
      publicationEpoch: 'test',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: tab.id,
      activeTabType: 'terminal',
      tabs: [tab]
    }).tabs[0]
  }

  setTitle(title: string, state: 'working' | 'idle' | null) {
    const pty = this.recordPtyWorktree(PTY_ID, WORKSPACE, {
      tabId: TAB_ID,
      paneKey: PANE_KEY,
      connected: true
    })
    pty.title = title
    pty.titleUpdatedAt = 1
    pty.lastOscTitle = title
    pty.lastOscTitleAt = 2
    pty.lastOscTitleEpochMs = Date.now()
    pty.lastAgentStatus = state
    pty.lastAgentStatusStartedAtEpochMs = Date.now()
  }
}

function row(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    tabId: TAB_ID,
    worktreeId: WORKSPACE,
    connectionId: null,
    agentType: 'codex',
    state: 'done',
    prompt: '',
    receivedAt: Date.now(),
    stateStartedAt: Date.now(),
    providerSession: SESSION,
    ...overrides
  }
}

function runtimeFor(rows: AgentStatusIpcPayload[]) {
  const runtime = new IdleChatRuntime(null, undefined, {
    getAgentStatusSnapshot: () => rows,
    getAgentProviderSessionRowsForPane: (paneKey) =>
      rows.filter((entry) => entry.paneKey === paneKey)
  })
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  return runtime
}

function expectChat(runtime: IdleChatRuntime, state: string) {
  const tab = runtime.project()
  expect(tab?.type === 'terminal' && tab.agentStatus).toMatchObject({
    state,
    agentType: 'codex',
    providerSession: SESSION
  })
  return tab
}

afterEach(() => vi.restoreAllMocks())

describe('mobile chat identity while idle', () => {
  it('keeps the same chat through working, completion, expiry and host restoration', () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const rows = [row({ state: 'working' })]
    const runtime = runtimeFor(rows)
    runtime.setTitle('Codex working', 'working')
    expectChat(runtime, 'working')

    clock.mockReturnValue(now + 1)
    rows[0] = row()
    runtime.setTitle('Respond to greeting | project', 'idle')
    expectChat(runtime, 'done')

    clock.mockReturnValue(now + AGENT_STATUS_STALE_AFTER_MS + 10)
    expectChat(runtime, 'done')
    const restored = runtimeFor(rows.map((entry) => ({ ...entry, restoredUnconfirmed: true })))
    restored.setTitle('Terminal', null)
    expectChat(restored, 'done')
  })

  it.each([{ providerSessionOnly: true }, { restoredUnconfirmed: true }, { receivedAt: 1 }])(
    'keeps chat for restored identity without a launch hint: %j',
    (overrides) => {
      const runtime = runtimeFor([row({ state: 'working', ...overrides })])
      runtime.setTitle('Terminal', 'idle')
      const tab = expectChat(runtime, 'done')
      expect(tab).not.toHaveProperty('launchAgent')
      expect(tab?.type === 'terminal' && tab.agentStatus).not.toHaveProperty('toolName')
    }
  )

  it('keeps history after the shell reclaims a pane without reviving its old tool', () => {
    const runtime = runtimeFor([row({ state: 'working', toolName: 'Bash', receivedAt: 1 })])
    runtime.setTitle('bash', null)
    expectChat(runtime, 'done')
  })

  it('does not invent a chat session from an idle title alone', () => {
    const runtime = runtimeFor([])
    runtime.setTitle('Respond to greeting | project', 'idle')
    expect(runtime.project()).not.toHaveProperty('agentStatus')
  })

  it('does not borrow a transcript from another pane', () => {
    const runtime = runtimeFor([row({ paneKey: makePaneKey('other-tab', LEAF_ID) })])
    runtime.setTitle('Terminal', 'idle')
    expect(runtime.project()).not.toHaveProperty('agentStatus')
  })

  it('stops publishing a transcript when the host removes its identity', () => {
    const rows = [row({ providerSessionOnly: true })]
    const runtime = runtimeFor(rows)
    runtime.setTitle('Terminal', 'idle')
    expectChat(runtime, 'done')
    rows.length = 0
    expect(runtime.project()).not.toHaveProperty('agentStatus')
  })
})
