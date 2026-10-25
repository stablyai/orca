import './rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import * as sessionCreate from './rpc/methods/structured-agent-session-create'
import { attachParams, providerFaults } from './structured-chat-coordinator-fake-codex-fixture'
import {
  COORDINATOR,
  call,
  codex,
  coordinatorRunAndTask,
  db,
  host,
  openChat,
  runtime
} from './structured-chat-coordinator-mail-rig.test-fixture'

it('keeps a minted worker start unknown after one preamble handover without an echo', async () => {
  await openChat(COORDINATOR)
  const { taskId } = await coordinatorRunAndTask()
  vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
  vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({ supported: true })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: placement reads only the workspace identity in this rig.
  vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
    id: 'workspace-1',
    repoId: 'repo'
  } as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: launch-mode selection reads only getSettings on this store double.
  vi.spyOn(runtime, 'requireStore').mockReturnValue({
    getSettings: () => ({
      experimentalNativeChat: true,
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {}
    })
  } as never)
  vi.spyOn(sessionCreate, 'createStructuredAgentSessionForWorktree').mockImplementation(
    async (args) => {
      const attached = await host.attach(args.caller, attachParams(args.envelope.sessionId))
      if (!attached.ok) {
        throw new Error('scripted worker attach refused')
      }
      return {
        ...attached,
        value: { ...attached.value, sessionId: args.envelope.sessionId, fence: attached.fence }
      }
    }
  )
  providerFaults.dieBeforeEveryEcho = true
  const receipt = await call(
    'orchestration.workerStart',
    {
      task: taskId,
      agent: 'codex',
      worktree: 'current'
    },
    { sessionId: COORDINATOR }
  )

  expect(receipt).toMatchObject({
    state: 'outcome_unknown',
    lastError: expect.stringMatching(/not acknowledged/)
  })
  expect(JSON.stringify(receipt.nextCommands)).toContain('worker-show')
  expect(JSON.stringify(receipt.nextCommands)).toContain('worker-abandon')
  const dispatchId = String(receipt.dispatchId)
  expect(db.getWorkerDispatch(dispatchId)?.state).toBe('start_unknown')
  const worker = codex.connections.at(-1)!
  const sessionId = db.getDispatchContextById(dispatchId)?.assignee_orca_session_id
  if (!sessionId) {
    throw new Error('minted worker session missing')
  }
  const snapshot = await host.journalSnapshot(sessionId)
  expect(snapshot.submissions).toHaveLength(1)
  expect(snapshot.submissions[0]).toMatchObject({ dispatchState: 'unknown' })
  expect(worker.turns).toHaveLength(1)
  expect(providerFaults.turnStarts).toBe(1)
})
