/**
 * A launch the host proves ran nothing says so beside its unchanged error code, so the window may
 * start the agent its own way, as it did before plain launches went through the host.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_TAB_CLOSED_CLIENT_CAPABILITY
} from '../../../../shared/agent-launch-runtime-capability'
import { AGENT_LAUNCH_NOTHING_RAN_DATA } from '../../../../shared/agent-launch-nothing-ran'
import { resetAgentLaunchPanesForTests } from '../../../agent-launch/agent-launch-pane-attachment'
import { openTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import { journalOpenRefusalError } from '../../../native-chat/agent-session-journal/journal-open-failure'
import { mapDispatcherError } from '../dispatcher-error-response'
import type { RpcContext } from '../core'
import { DESKTOP_RPC_CALLER } from '../rpc-caller-identity'
import {
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore
} from './agent-launch.test-fixture'

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH_REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')

const TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LEAF_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const DESKTOP: Partial<RpcContext> = {
  caller: DESKTOP_RPC_CALLER,
  clientKind: 'runtime',
  clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY, AGENT_LAUNCH_TAB_CLOSED_CLIENT_CAPABILITY]
}

let directory: string
let operationCounter = 0

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agent-launch-nothing-ran-'))
  setAgentLaunchRecordStore(await openTestAgentSessionRecordStore(directory))
})

afterEach(async () => {
  setAgentLaunchRecordStore(null)
  resetAgentLaunchPanesForTests()
  await rm(directory, { recursive: true, force: true })
})

/** A host whose window shows the launch's tab. */
function hostWithWindow() {
  return runtimeStub({
    settings: {},
    terminalPaneKey: PANE_KEY,
    publishAgentLaunchTab: (request) =>
      Promise.resolve({ tabId: request.tabId, created: true, placement: { groupId: 'g-1' } })
  })
}

/** The launch record will not open, refused as the journal open refuses it. */
function withoutRecord(runtime: ReturnType<typeof hostWithWindow>) {
  runtime.openedAgentSessionRecordStore.mockReturnValue(null)
  runtime.openAgentSessionRecordStore.mockRejectedValue(
    journalOpenRefusalError(
      Object.assign(new Error('unable to open database file'), { code: 'EACCES' })
    )
  )
  return runtime
}

/** The launch's failure as the window receives it. */
async function launchFailure(runtime: ReturnType<typeof hostWithWindow>) {
  operationCounter += 1
  const thrown = await AGENT_LAUNCH_REPLAY.handler(
    AGENT_LAUNCH_REPLAY.params.parse({
      agent: 'claude',
      target: { kind: 'existing', worktree: 'id:wt-7' },
      operationId: `${Date.now()}-${operationCounter.toString(16).padStart(32, '0')}`,
      paneKey: PANE_KEY
    }),
    rpcContext(runtime, DESKTOP)
  ).then(
    () => null,
    (error: unknown) => error
  )
  const request = { id: 'req-1', authToken: 'token', method: 'agent.launchReplay' }
  const response = mapDispatcherError(request, { runtimeId: 'runtime-1' }, thrown)
  return response.ok ? null : response.error
}

describe('a launch the host proves ran nothing', () => {
  it('with no launch record: starts nothing, takes its tab back, keeps its refusal', async () => {
    const runtime = withoutRecord(hostWithWindow())

    const failure = await launchFailure(runtime)
    // Its refusal still reaches older peers as it did; the fact rides beside it.
    expect(failure).toMatchObject({
      data: { refusal: expect.anything(), ...AGENT_LAUNCH_NOTHING_RAN_DATA }
    })
    expect(runtime.createTerminal).not.toHaveBeenCalled()
    await expect
      .poll(() => runtime.reportAgentLaunchPaneVerdict.mock.calls)
      .toEqual([[{ worktreeId: 'wt-7', tabId: TAB_ID, leafId: LEAF_ID }, { kind: 'withdrawn' }]])
  })

  it('failing before its spawn left', async () => {
    const runtime = hostWithWindow()
    runtime.createTerminal.mockRejectedValueOnce(new Error('spawn claude ENOENT'))

    expect(await launchFailure(runtime)).toMatchObject({ data: AGENT_LAUNCH_NOTHING_RAN_DATA })
  })

  // Why: a spawn the daemon was asked for may be running; the window must never start a second.
  it('is never said of a spawn that left', async () => {
    const runtime = hostWithWindow()
    runtime.createTerminal.mockImplementationOnce(async (_selector, createOptions) => {
      const dispatched = createOptions?.onPtySpawnDispatched
      if (typeof dispatched === 'function') {
        dispatched()
      }
      throw new Error('daemon unreachable')
    })

    const failure = await launchFailure(runtime)
    expect(failure).toMatchObject({ code: 'agent_session_operation_unknown' })
    expect(failure).not.toHaveProperty('data')
  })
})
