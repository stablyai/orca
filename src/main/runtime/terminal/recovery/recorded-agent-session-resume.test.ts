import { describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { partialRuntimeStore } from '../../construction/test-context/runtime-store-partial-fixture'
import type { AgentSessionResumeClaims } from '../../session-lifecycle/projection/agent-session-resume-claims'

await import('../../construction/test-context/runtime-test-module-registration.spec')
const { OrcaRuntimeService } = await import('../../orca-runtime')
await import('../../construction/test-context/orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('../../construction/test-context/orca-runtime-test-fixtures.spec')
const { committingSpawn } = await import('../layout/bind-first-pane.test-fixture')

const PANE = `host-tab:${HEADLESS_LEAF_ID}`
const SESSION = '0bc9e9f8-192c-4bd4-beb8-8b745c59c8b0'

function sleepingConversation(
  overrides: Partial<SleepingAgentSessionRecord> = {},
  spawnError?: Error | (() => Error | undefined),
  pty: { reattach?: boolean; shellAlone?: () => boolean } = {}
) {
  const record: SleepingAgentSessionRecord = {
    worktreeId: TEST_WORKTREE_ID,
    paneKey: PANE,
    tabId: 'host-tab',
    agent: 'codex',
    providerSession: { key: 'session_id', id: SESSION },
    state: 'done',
    prompt: '',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'worktree-sleep',
    launchConfig: { agentArgs: '--model saved-model', agentEnv: { SAVED: '1' } },
    ...overrides
  }
  const session = makeWorkspaceSessionWithHeadlessTerminal()
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
    ...session,
    sleepingAgentSessionsByPaneKey: { [PANE]: record }
  })
  const launches: { command?: string; tabId?: string; leafId?: string }[] = []
  const runtime = new OrcaRuntimeService(partialRuntimeStore(runtimeStore))
  runtime.setPtyController({
    spawn: committingSpawn(
      runtime,
      vi.fn(async (args) => {
        launches.push(args)
        const error = typeof spawnError === 'function' ? spawnError() : spawnError
        if (error) {
          throw error
        }
        return { id: 'resumed-original-pane', ...(pty.reattach ? { isReattach: true } : {}) }
      })
    ),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    confirmShellForeground: async () => pty.shellAlone?.() ?? false
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  return { runtime, launches }
}

describe('resuming an explicitly selected recorded conversation', () => {
  it('resumes a sleeping conversation in its original pane and shares overlapping requests', async () => {
    const { runtime, launches } = sleepingConversation()
    const [first, second] = await Promise.all([
      runtime.resumeRecordedAgentSession(`id:${TEST_WORKTREE_ID}`, { paneKey: PANE }),
      runtime.resumeRecordedAgentSession(`id:${TEST_WORKTREE_ID}`, {
        agent: 'codex',
        sessionId: SESSION
      })
    ])
    expect(first).toEqual({
      worktreeId: TEST_WORKTREE_ID,
      paneKey: PANE,
      agent: 'codex',
      providerSession: { key: 'session_id', id: SESSION },
      handle: second.handle,
      ptyId: 'resumed-original-pane',
      disposition: 'resumed'
    })
    expect(launches).toEqual([
      expect.objectContaining({
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        command: expect.stringContaining(SESSION)
      })
    ])
    expect(launches[0]?.command).toContain("'--model' 'saved-model'")
    expect(
      await runtime.resumeRecordedAgentSession(`id:${TEST_WORKTREE_ID}`, { paneKey: PANE })
    ).toEqual({ ...first, disposition: 'adopted' })
    expect((await runtime.listRecordedAgentSessions(`id:${TEST_WORKTREE_ID}`)).sessions).toEqual([
      expect.objectContaining({ paneKey: PANE, connected: true })
    ])
  })

  it('retains an uncertain spawn instead of dispatching a second restore on retry', async () => {
    const { runtime, launches } = sleepingConversation({}, new Error('lost spawn reply'))
    const resume = () =>
      runtime.resumeRecordedAgentSession(`id:${TEST_WORKTREE_ID}`, { paneKey: PANE })
    await expect(resume()).rejects.toThrow('lost spawn reply')
    await expect(resume()).rejects.toThrow('lost spawn reply')
    expect(launches).toEqual([
      expect.objectContaining({ tabId: 'host-tab', leafId: HEADLESS_LEAF_ID })
    ])
  })

  it('retries a failed restore once no overlapping resume of its pane is unsettled', async () => {
    let spawnError: Error | undefined = new Error('agent_session_exited_during_start')
    const { runtime, launches } = sleepingConversation({}, () => spawnError)
    // Another resumer of the same pane, such as a window materializing it, still owns its share.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test plays that resumer through the runtime's own claim registry.
    const claims = (runtime as unknown as { agentSessionResumeClaims: AgentSessionResumeClaims })
      .agentSessionResumeClaims
    const overlapping = claims.claim(
      { agent: 'codex', providerSession: { key: 'session_id', id: SESSION } },
      PANE
    )!
    const resume = () =>
      runtime.resumeRecordedAgentSession(`id:${TEST_WORKTREE_ID}`, { paneKey: PANE })
    await expect(resume()).rejects.toThrow('agent_session_exited_during_start')
    await expect(resume()).rejects.toThrow('agent_session_exited_during_start')
    expect(launches).toHaveLength(1)
    overlapping.settleFailure(false)
    spawnError = undefined
    expect((await resume()).disposition).toBe('resumed')
    expect(launches).toHaveLength(2)
  })

  it('refuses a different session instead of launching a fresh agent', async () => {
    const { runtime, launches } = sleepingConversation()
    await expect(
      runtime.resumeRecordedAgentSession(`id:${TEST_WORKTREE_ID}`, {
        paneKey: PANE,
        agent: 'codex',
        sessionId: 'another-conversation'
      })
    ).rejects.toThrow('No recorded conversation matches')
    expect(launches).toEqual([])
  })

  it('keeps an unresumable record without falling back to the pane launch command', async () => {
    const { runtime, launches } = sleepingConversation({
      providerSession: { key: 'conversation_id', id: SESSION }
    })
    await expect(
      runtime.resumeRecordedAgentSession(`id:${TEST_WORKTREE_ID}`, {
        paneKey: PANE
      })
    ).rejects.toThrow('agent_session_resume_not_authorized')
    expect(launches).toEqual([])
  })

  it('stops adopting a claimed terminal once only its shell remains', async () => {
    let shellAlone = false
    const { runtime } = sleepingConversation({}, undefined, { shellAlone: () => shellAlone })
    const resume = () =>
      runtime.resumeRecordedAgentSession(`id:${TEST_WORKTREE_ID}`, { paneKey: PANE })
    expect((await resume()).disposition).toBe('resumed')
    shellAlone = true
    await expect(resume()).rejects.toThrow('could not be verified')
  })

  it('reports a reattached terminal as adopted, never as a fresh resume', async () => {
    const { runtime } = sleepingConversation({}, undefined, { reattach: true })
    expect(
      (await runtime.resumeRecordedAgentSession(`id:${TEST_WORKTREE_ID}`, { paneKey: PANE }))
        .disposition
    ).toBe('adopted')
  })

  it('refuses a reattached terminal that is only a shell', async () => {
    const { runtime } = sleepingConversation({}, undefined, {
      reattach: true,
      shellAlone: () => true
    })
    await expect(
      runtime.resumeRecordedAgentSession(`id:${TEST_WORKTREE_ID}`, { paneKey: PANE })
    ).rejects.toThrow('did not resume in its pane')
  })
})
