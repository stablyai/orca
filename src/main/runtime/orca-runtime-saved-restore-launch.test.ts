import { describe, expect, it, vi } from 'vitest'
import { EnsureAgentSessionParams } from '../../shared/rpc-contract/agent-session-params'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import { OrcaRuntimeService } from './orca-runtime'
import { partialRuntimeStore } from './orca-runtime-tests/runtime-store-partial-fixture'

const TAB = '11111111-1111-4111-8111-111111111111'
const SOURCE_PANE = `${TAB}:22222222-2222-4222-8222-222222222222`
const NEW_TAB = '33333333-3333-4333-8333-333333333333'
const NEW_LEAF = '44444444-4444-4444-8444-444444444444'
const SESSION = { key: 'session_id', id: 'conversation-1' } as const

function restoreOnHost(args: {
  recorded?: { agentArgs: string; agentEnv: Record<string, string> }
  hookMode?: string
}) {
  const runtime = new OrcaRuntimeService(
    partialRuntimeStore({
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: { claude: '--model current' },
        agentDefaultEnv: { claude: { CURRENT: '1' } }
      })
    })
  )
  const record = {
    paneKey: SOURCE_PANE,
    worktreeId: 'worktree-1',
    agent: 'claude' as const,
    providerSession: SESSION,
    prompt: '',
    state: 'done' as const,
    capturedAt: 1,
    updatedAt: 1,
    ...(args.recorded ? { launchConfig: args.recorded } : {})
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host's restore reads only the row's pane, agent and provider session.
  const hookRow = {
    paneKey: SOURCE_PANE,
    agentType: 'claude',
    providerSession: { ...SESSION, permissionMode: args.hookMode }
  } as AgentStatusIpcPayload
  Object.assign(runtime, {
    resolveTerminalWorkspaceLaunchScope: vi.fn(async () => ({
      id: 'worktree-1',
      path: '/tmp/worktree-1',
      connectionId: null
    })),
    getWorkspaceSessionForWorktree: () => ({
      sleepingAgentSessionsByPaneKey: { [SOURCE_PANE]: record }
    }),
    getAgentProviderSessionSnapshotFn: () => [hookRow]
  })
  const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
    handle: 'term_restore',
    tabId: NEW_TAB,
    paneKey: `${NEW_TAB}:${NEW_LEAF}`,
    ptyId: 'pty-restore',
    worktreeId: 'worktree-1',
    title: null,
    surface: 'background'
  })
  return {
    restore: () =>
      runtime.ensureAgentSession(
        EnsureAgentSessionParams.parse({
          kind: 'explicit',
          resumeOrigin: 'saved',
          restoreSourcePaneKey: SOURCE_PANE,
          worktree: 'id:worktree-1',
          agent: 'claude',
          providerSession: SESSION,
          agentArgs: '--model client',
          placement: { tabId: NEW_TAB, leafId: NEW_LEAF }
        })
      ),
    launched: () => createTerminal.mock.calls[0]?.[1]
  }
}

// A Wake opens a new tab: the host must replay the pane that ran, not the new pane or its own settings.
describe('a saved restore into a new pane on its host', () => {
  it("replays the source pane's note", async () => {
    const host = restoreOnHost({
      recorded: { agentArgs: '--verbose', agentEnv: { RECORDED: '1' } }
    })
    await host.restore()
    expect(host.launched()?.command).toContain('--verbose')
    expect(host.launched()?.command).not.toContain('--model')
    expect(host.launched()?.env).toMatchObject({ RECORDED: '1' })
    expect(host.launched()?.env).not.toHaveProperty('CURRENT')
  })

  it("without a note, keeps only the bypass the host's hooks saw, never current settings", async () => {
    const host = restoreOnHost({ hookMode: 'bypassPermissions' })
    await host.restore()
    expect(host.launched()?.command).toContain('--dangerously-skip-permissions')
    expect(host.launched()?.command).not.toContain('--model')
    expect(host.launched()?.env).not.toHaveProperty('CURRENT')
  })
})
