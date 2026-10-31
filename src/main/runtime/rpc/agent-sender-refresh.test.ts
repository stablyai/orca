import './unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import { RpcDispatcher } from './dispatcher'
import { ORCHESTRATION_METHODS } from './methods/orchestration'
import { createOrchestrationRpcHarness } from './methods/orchestration/rpc-test-harness'
import { createRootDispatch } from '../orchestration/db/root-dispatch-test-fixture'
import { MIRROR_LEAVES_STEP_1 } from '../runtime-leaf-record-projection.test-fixture'
import type { RuntimeAgentSenderAssociations } from '../runtime-agent-sender-associations'
import type { RuntimeLeafRecord } from '../runtime-terminal-state-records'
import type { OrcaRuntimeService } from '../orca-runtime'

const harness = createOrchestrationRpcHarness()
afterEach(() => {
  harness.cleanup()
  vi.restoreAllMocks()
})

const paneOf = (i: number) =>
  `tab_h${i}:${i.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
// The runtime's own state, reached the way its RPC refresh reaches it.
type Internals = {
  agentProjections: { senders: RuntimeAgentSenderAssociations }
  leaves: Map<string, RuntimeLeafRecord>
  mobileSessionTabsByWorktree: Map<string, unknown>
}
const internals = (runtime: OrcaRuntimeService) => runtime as unknown as Internals

it.each([50, 500])(
  'orchestration RPCs that change no identity do no identity work and republish nothing at %i dispatches',
  async (n) => {
    const { db, runtime, activeRunId } = harness.setup()
    for (let i = 0; i < n; i++) {
      const task = db.createTask({ spec: `history ${i}` })
      createRootDispatch(db, task.id, `term_hist_${i}`, paneOf(i))
      db.insertMessage({
        from: `term_hist_${i}`,
        to: 'term_coord',
        subject: 'old',
        senderPaneKey: paneOf(i)
      })
    }
    const {
      agentProjections: { senders },
      leaves,
      mobileSessionTabsByWorktree
    } = internals(runtime)
    leaves.set('live', {
      ...MIRROR_LEAVES_STEP_1[0],
      tabId: 'tab_h0',
      worktreeId: 'workspace',
      ptyId: 'pty-live'
    })
    mobileSessionTabsByWorktree.set('workspace', {})
    const touch = vi
      .spyOn(runtime, 'touchMobileSessionTabsForWorktree')
      .mockImplementation(() => undefined)
    senders.buildForFrame('workspace')
    const settled = senders.workForTest()
    expect(settled.historyReads).toBe(1)
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const send = (subject: string, type?: string) =>
      dispatcher.dispatch({
        id: `rpc_${subject}`,
        authToken: 'test-token',
        method: 'orchestration.send',
        params: {
          from: 'term_coord',
          to: `run:${activeRunId}`,
          subject,
          ...(type ? { type } : {})
        },
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: `mutation_${subject}`
      })
    for (let k = 0; k < 5; k++) {
      await send(`status ${k}`)
      await send(`beat ${k}`, 'heartbeat')
    }
    // The refresh runs in a microtask after each RPC.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(senders.workForTest()).toEqual(settled)
    expect(touch).not.toHaveBeenCalled()

    // A real identity change reaches only the worktree whose scope changed.
    senders.observeHook(db, {
      paneKey: `${leaves.get('live')!.tabId}:${leaves.get('live')!.leafId}`,
      agent: 'claude',
      session: 'live',
      process: undefined,
      dispatchId: null
    })
    await send('after identity change')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(touch.mock.calls.map(([worktreeId]) => worktreeId)).toEqual(['workspace'])
  }
)
