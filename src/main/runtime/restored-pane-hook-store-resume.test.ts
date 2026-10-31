// verify-15a parity: a host whose daemon restarted resumed nothing and replayed the pane's launch.
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { partialRuntimeStore } from './runtime-store-partial-fixture'

// Preserve side-effect order: mocks, lifecycle, fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-test-fixtures.spec')
const { committingSpawn } = await import('./bind-first-pane.test-fixture')

const PANE_KEY = `host-tab:${HEADLESS_LEAF_ID}`
const SESSION_ID = '0bc9e9f8-192c-4bd4-beb8-8b745c59c8b0'
const RESUMES = new RegExp(`resume'? '?${SESSION_ID}`)

function codexRow(fields: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    agentType: 'codex',
    providerSession: { key: 'session_id', id: SESSION_ID },
    prompt: 'hello p7',
    state: 'done',
    receivedAt: 1,
    stateStartedAt: 1,
    connectionId: null,
    ...fields
  }
}

function makeRuntime(
  rows: AgentStatusIpcPayload[],
  launchAgent?: 'codex',
  {
    session: overrides = {},
    presence = 'exited'
  }: {
    session?: Partial<WorkspaceSessionState>
    presence?: 'live' | 'exited'
  } = {}
) {
  const session = makeWorkspaceSessionWithHeadlessTerminal()
  const [tab] = session.tabsByWorktree[TEST_WORKTREE_ID] ?? []
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
    ...session,
    tabsByWorktree: { [TEST_WORKTREE_ID]: [{ ...tab!, ...(launchAgent ? { launchAgent } : {}) }] },
    ...overrides
  })
  const spawn = vi.fn(
    async (_args: { worktreeId?: string; tabId?: string; leafId?: string; command?: string }) => ({
      id: 'restored-pty'
    })
  )
  const runtime = new OrcaRuntimeService(partialRuntimeStore(runtimeStore), undefined, {
    getAgentProviderSessionSnapshot: () => rows,
    getAgentProviderSessionRowsForPane: (paneKey: string) =>
      rows.filter((row) => row.paneKey === paneKey),
    checkHookAgentPresence: async () => presence
  })
  runtime.setPtyController({
    spawn: committingSpawn(runtime, spawn),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  return { runtime, spawn }
}

/** Main's fresh launch: a new conversation, which can't collide with the vetoed one. */
function expectFreshLaunch(command: string | undefined): void {
  expect(command ?? '').not.toMatch(RESUMES)
  expect(command).toContain('codex')
}

async function restore(runtime: InstanceType<typeof OrcaRuntimeService>): Promise<void> {
  await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', HEADLESS_LEAF_ID, {
    notifyClients: false,
    navigation: 'caller',
    intent: 'automatic'
  })
}

describe('restoring a pane its host recorded an agent in', () => {
  it('resumes an agent typed into a shell, which no launch command names', async () => {
    const { runtime, spawn } = makeRuntime([codexRow()])
    await restore(runtime)
    expect(spawn.mock.calls[0]![0].command).toMatch(RESUMES)
  })

  it('resumes an agent whose process exit left only its resume identity', async () => {
    const { runtime, spawn } = makeRuntime([codexRow({ providerSessionOnly: true })], 'codex')
    await restore(runtime)
    expect(spawn.mock.calls[0]![0].command).toMatch(RESUMES)
  })

  it('never resumes a conversation a relayed SSH row names', async () => {
    const { runtime, spawn } = makeRuntime([codexRow({ connectionId: 'ssh-1' })])
    await restore(runtime)
    expect(spawn.mock.calls[0]![0].command ?? '').not.toContain('resume')
  })

  it('ignores a row from another worktree, and launches the tab’s agent fresh', async () => {
    const { runtime, spawn } = makeRuntime(
      [codexRow({ worktreeId: 'other-repo::/other' })],
      'codex'
    )
    await restore(runtime)
    const { command } = spawn.mock.calls[0]![0]
    expect(command ?? '').not.toMatch(RESUMES)
    expect(command).toContain('codex')
  })

  it('launches the tab’s agent fresh when the pane’s own rows name two conversations', async () => {
    const { runtime, spawn } = makeRuntime(
      [
        codexRow({ receivedAt: 2 }),
        codexRow({ providerSession: { key: 'session_id', id: 'another-session' }, receivedAt: 1 })
      ],
      'codex'
    )
    await restore(runtime)
    expectFreshLaunch(spawn.mock.calls[0]![0].command)
  })

  it('launches the tab’s agent fresh when another pane’s stored record holds the conversation', async () => {
    const otherPaneKey = 'other-tab:44444444-4444-4444-8444-444444444444'
    const { runtime, spawn } = makeRuntime([codexRow()], 'codex', {
      session: {
        sleepingAgentSessionsByPaneKey: {
          [otherPaneKey]: {
            paneKey: otherPaneKey,
            worktreeId: TEST_WORKTREE_ID,
            tabId: 'other-tab',
            agent: 'codex',
            providerSession: { key: 'session_id', id: SESSION_ID },
            state: 'done',
            prompt: '',
            capturedAt: 1,
            updatedAt: 1,
            origin: 'live'
          }
        }
      }
    })
    await restore(runtime)
    expectFreshLaunch(spawn.mock.calls[0]![0].command)
  })

  it('falls back to the tab’s agent launch when the newest row is a structured host’s', async () => {
    const { runtime, spawn } = makeRuntime([codexRow({ structuredHost: 'owned' })], 'codex')
    await restore(runtime)
    const { command } = spawn.mock.calls[0]![0]
    expect(command ?? '').not.toMatch(RESUMES)
    expect(command).toContain('codex')
  })

  it('resumes a pane whose only other row is a relayed SSH row naming another session', async () => {
    const { runtime, spawn } = makeRuntime(
      [
        codexRow(),
        codexRow({
          providerSession: { key: 'session_id', id: 'remote-session' },
          connectionId: 'ssh-1',
          receivedAt: 2
        })
      ],
      'codex'
    )
    await restore(runtime)
    expect(spawn.mock.calls[0]![0].command).toMatch(RESUMES)
  })
})
