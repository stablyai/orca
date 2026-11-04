import './unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import { RpcDispatcher } from './dispatcher'
import { ORCHESTRATION_METHODS } from './methods/orchestration'
import { createOrchestrationRpcHarness } from './methods/orchestration/rpc-test-harness'
import { createRootDispatch } from '../orchestration/db/root-dispatch-test-fixture'
import { MIRROR_LEAVES_STEP_1 } from '../runtime-leaf-record-projection.test-fixture'
import type { RuntimeAgentSenderAssociations } from '../runtime-agent-sender-associations'
import { publishHeadlessRuntimeGraph } from '../headless-runtime-graph'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-types'

const harness = createOrchestrationRpcHarness()
afterEach(() => {
  harness.cleanup()
  vi.restoreAllMocks()
})

const paneOf = (i: number) =>
  `tab_h${i}:${i.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
/** History, chat and lineage reads, apart from the live-terminal walk each refresh makes. */
const identityReads = (senders: RuntimeAgentSenderAssociations) => {
  const { leafVisits: _leaves, ptyVisits: _ptys, ...reads } = senders.workForTest()
  return reads
}

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
    // The runtime's own state, reached the way its RPC refresh reaches it.
    const { senders } = runtime['agentProjections']
    const ptysById = runtime['ptysById']
    // A terminal the runtime knows, with the handle it issued when it learned of it.
    const openTerminal = (key: string, tabId: string) => {
      const leaf = {
        ...MIRROR_LEAVES_STEP_1[0],
        tabId,
        worktreeId: 'workspace',
        ptyId: `pty-${key}`
      }
      runtime['terminalIdentity'].replaceLeaves(new Map([...runtime['leaves'], [key, leaf]]))
      runtime['issueHandle'](leaf)
    }
    openTerminal('live', 'tab_h0')
    runtime.mobileSessionTabsByWorktree.set('workspace', {
      worktree: 'workspace',
      publicationEpoch: 'host',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    })
    const touch = vi
      .spyOn(runtime, 'touchMobileSessionTabsForWorktree')
      .mockImplementation(() => undefined)
    const unsubscribe = runtime.onMobileSessionTabsChanged(() => undefined, undefined, 'runtime')
    await senders.buildForFrame('workspace')
    const settled = identityReads(senders)
    const walked = senders.workForTest()
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
    const rpcs = 10
    for (let k = 0; k < rpcs / 2; k++) {
      await send(`status ${k}`)
      await send(`beat ${k}`, 'heartbeat')
    }
    // The refresh runs in a microtask after each RPC.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(identityReads(senders)).toEqual(settled)
    // Each RPC's refresh walks the live terminals once, and nothing more.
    expect({
      leaves: senders.workForTest().leafVisits - walked.leafVisits,
      ptys: senders.workForTest().ptyVisits - walked.ptyVisits
    }).toEqual({ leaves: rpcs * runtime['leaves'].size, ptys: rpcs * ptysById.size })
    expect(touch).not.toHaveBeenCalled()

    // A real identity change, a new terminal, reaches only the worktree whose scope changed.
    openTerminal('opened', 'tab_h1')
    await send('after identity change')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(touch.mock.calls.map(([worktreeId]) => worktreeId)).toEqual(['workspace'])
    unsubscribe()
  }
)

it.each([100, 1000])(
  'skips post-orchestration sender refresh with only phones at %i terminals',
  async (n) => {
    const { runtime, activeRunId } = harness.setup()
    const leaves = new Map(runtime['leaves'])
    for (let i = 0; i < n; i++) {
      leaves.set(`leaf${i}`, {
        ...MIRROR_LEAVES_STEP_1[0],
        tabId: `tab${i}`,
        worktreeId: 'workspace',
        ptyId: `pty${i}`
      })
    }
    runtime['terminalIdentity'].replaceLeaves(leaves)
    const senders = runtime['agentProjections'].senders
    const phone = runtime.onMobileSessionTabsChanged(() => undefined, 'phone', 'mobile')
    const before = senders.workForTest()
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const result = await dispatcher.dispatch({
      id: 'phone-send',
      authToken: 'test-token',
      method: 'orchestration.send',
      params: { from: 'term_coord', to: `run:${activeRunId}`, subject: 'phone-only' },
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'phone-send'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(result.ok).toBe(true)
    expect(senders.workForTest()).toEqual(before)
    phone()
  }
)

it('headless and discarded internal graph replies skip sender construction; desktop replies still build', async () => {
  const { runtime } = harness.setup()
  const senders = runtime['agentProjections'].senders
  const build = vi.spyOn(senders, 'buildForGraph')
  publishHeadlessRuntimeGraph(runtime)
  expect(build).not.toHaveBeenCalled()
  await runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  expect(build).not.toHaveBeenCalled()
  runtime.attachWindow(1)
  await runtime.syncWindowGraph(1, { tabs: [], leaves: [] }, { includeAgentSenders: false })
  expect(build).not.toHaveBeenCalled()
  const reply = await runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  expect(build).toHaveBeenCalledTimes(1)
  expect(reply.agentSenderAssociations).toBeDefined()
})
