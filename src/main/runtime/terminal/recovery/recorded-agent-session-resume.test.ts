import { describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { partialRuntimeStore } from '../../orca-runtime-tests/runtime-store-partial-fixture'

await import('../../orca-runtime-tests/runtime-test-module-registration.spec')
const { OrcaRuntimeService } = await import('../../orca-runtime')
await import('../../orca-runtime-tests/orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('../../orca-runtime-tests/orca-runtime-test-fixtures.spec')
const { committingSpawn } = await import('../../orca-runtime-tests/bind-first-pane.test-fixture')

const PANE = `host-tab:${HEADLESS_LEAF_ID}`
const SESSION = '0bc9e9f8-192c-4bd4-beb8-8b745c59c8b0'

function sleepingConversation(
  overrides: Partial<SleepingAgentSessionRecord> = {},
  spawnError?: Error
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
        if (spawnError) {
          throw spawnError
        }
        return { id: 'resumed-original-pane' }
      })
    ),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
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
})
