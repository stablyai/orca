// Pins main's current launch behaviour as the baseline the spawn-lane merge must keep (host create).
import { describe, expect, it, onTestFinished, vi } from 'vitest'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { HEADLESS_LEAF_ID, TEST_WORKTREE_ID, TEST_WORKTREE_PATH, store } =
  await import('./orca-runtime-test-fixtures.spec')
const { ClaudeAgentTeamsService } = await import('./claude-agent-teams-service')

const SPAWN_REACHED = 'spawn_reached'

function makeRuntime(
  adoptStablePane: () => Promise<null>,
  runtimeStore: ConstructorParameters<typeof OrcaRuntimeService>[0] = store
) {
  const runtime = new OrcaRuntimeService(runtimeStore)
  // Rejecting keeps the test at the spawn boundary; only what reached it matters here.
  const spawn = vi.fn(async (_args: Record<string, unknown>) => {
    throw new Error(SPAWN_REACHED)
  })
  runtime.setPtyController({
    adoptStablePane: vi.fn(adoptStablePane),
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  return { runtime, spawn }
}

describe('launch race parity: host createTerminal around its spawn', () => {
  // Row 13: orca-runtime-create-terminal.ts:60-62.
  it('refuses before adopting the pane when the client already disconnected', async () => {
    const adoptStablePane = vi.fn(async () => null)
    const { runtime, spawn } = makeRuntime(adoptStablePane)
    const abort = new AbortController()
    abort.abort()

    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'guard-disconnected-before-adopt',
        leafId: HEADLESS_LEAF_ID,
        signal: abort.signal
      })
    ).rejects.toThrow('client_disconnected')

    expect(adoptStablePane).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  // Row 13: orca-runtime-create-terminal.ts:119-121.
  it('refuses before spawning when the client disconnects during pane adoption', async () => {
    const abort = new AbortController()
    const { runtime, spawn } = makeRuntime(async () => {
      abort.abort()
      return null
    })

    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'guard-disconnected-during-adopt',
        leafId: HEADLESS_LEAF_ID,
        signal: abort.signal
      })
    ).rejects.toThrow('client_disconnected')

    expect(spawn).not.toHaveBeenCalled()
  })

  // Row 13: orca-runtime-create-terminal.ts:167.
  it('hands the client signal and the slept-worktree refusal to the spawn', async () => {
    const { runtime, spawn } = makeRuntime(async () => null)
    const abort = new AbortController()

    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'guard-forwarded',
        leafId: HEADLESS_LEAF_ID,
        signal: abort.signal,
        refuseSleptWorktree: true
      })
    ).rejects.toThrow(SPAWN_REACHED)

    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      signal: abort.signal,
      refuseSleptWorktree: true
    })
  })

  // Row 6 drift: the window lane releases the Agent Teams leader of a failed start
  // (ipc/spawn-run.ts:81); the host builds the team (orca-runtime-create-terminal.ts:92-98) and
  // releases nothing when the spawn fails (:103, :178).
  it('keeps the Agent Teams team it built when the spawn fails', async () => {
    const removeTeam = vi.spyOn(ClaudeAgentTeamsService.prototype, 'removeTeamForLeaderHandle')
    onTestFinished(() => removeTeam.mockRestore())
    const { runtime, spawn } = makeRuntime(async () => null, {
      ...store,
      getSettings: () => ({ ...store.getSettings(), claudeAgentTeamsMode: 'in-process' as const })
    })

    await expect(
      runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { command: "claude 'hello'" })
    ).rejects.toThrow(SPAWN_REACHED)

    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      env: expect.objectContaining({ CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' })
    })
    expect(removeTeam).not.toHaveBeenCalled()
  })
})
