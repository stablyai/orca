import { afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import './orca-runtime-test-lifecycle.spec'
import { store, TEST_WORKTREE_ID, TEST_WORKTREE_PATH } from './orca-runtime-test-fixtures.spec'
import { createExistingWorktreeWorkerTerminal } from './rpc/methods/orchestration/worker/worker-topology'
import { AgentHookServer } from '../agent-hooks/server'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'

afterEach(() => vi.unstubAllEnvs())

it('gives a Claude-created Codex worker a separate pane and launch credential', async () => {
  const spawned: Record<string, string>[] = []
  const runtime = new OrcaRuntimeService(store)
  const hooks = new AgentHookServer()
  runtime.setPtyController({
    spawn: async (args: { env?: Record<string, string> }) => {
      spawned.push(args.env ?? {})
      return { id: `pty-${spawned.length}` }
    },
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { startupAgent: 'claude' })
  const parent = spawned[0]
  expect(parent.ORCA_PANE_KEY).toBeTruthy()
  expect(parent.ORCA_AGENT_LAUNCH_TOKEN).toBeTruthy()
  vi.stubEnv('ORCA_PANE_KEY', parent.ORCA_PANE_KEY)
  vi.stubEnv('ORCA_AGENT_LAUNCH_TOKEN', parent.ORCA_AGENT_LAUNCH_TOKEN)

  await createExistingWorktreeWorkerTerminal({
    runtime,
    worktreeId: TEST_WORKTREE_ID,
    agent: 'codex',
    taskId: 'child-task',
    effects: []
  })
  const child = spawned[1]
  expect(child.ORCA_PANE_KEY).toBeTruthy()
  expect(child.ORCA_PANE_KEY).not.toBe(parent.ORCA_PANE_KEY)
  expect(child.ORCA_AGENT_LAUNCH_TOKEN).toBeTruthy()
  expect(child.ORCA_AGENT_LAUNCH_TOKEN).not.toBe(parent.ORCA_AGENT_LAUNCH_TOKEN)

  for (const [env, agent, sessionId] of [
    [parent, 'claude', 'parent-session'],
    [child, 'codex', 'worker-session']
  ] as const) {
    const event = normalizeHookPayload(
      hooks._getStateForTests(),
      agent,
      {
        paneKey: env.ORCA_PANE_KEY,
        tabId: env.ORCA_TAB_ID,
        worktreeId: env.ORCA_WORKTREE_ID,
        launchToken: env.ORCA_AGENT_LAUNCH_TOKEN,
        payload: { hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'work' }
      },
      'production'
    )
    expect(event).not.toBeNull()
    if (!event) {
      throw new Error('Provider hook was not normalized')
    }
    hooks.ingestRemote(event, null)
  }
  expect(hooks.getStatusSnapshot()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        paneKey: parent.ORCA_PANE_KEY,
        agentType: 'claude',
        providerSession: expect.objectContaining({ id: 'parent-session' })
      }),
      expect.objectContaining({
        paneKey: child.ORCA_PANE_KEY,
        agentType: 'codex',
        providerSession: expect.objectContaining({ id: 'worker-session' })
      })
    ])
  )
  hooks.stop()
})
