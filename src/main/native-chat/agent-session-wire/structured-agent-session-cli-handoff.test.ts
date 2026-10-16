import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import type * as CliStop from '../../runtime/structured-agent-cli-stop'
import { createRestTestRig, type RestTestRig } from './structured-agent-session-rest-test-rig'
import { createTestParams, CREATE_TEST_CALLER } from './structured-agent-session-create-test-fixture'
import {
  HOST_TEST_LOCATION, HOST_TEST_SESSION, HOST_TEST_THREAD, hostTestOperationId
} from './structured-agent-session-host-test-data'

const stop = vi.hoisted(() => ({
  capture: vi.fn(), judge: vi.fn(), probe: vi.fn()
}))
vi.mock('../../runtime/structured-agent-cli-stop', async (load) => ({
  ...await load<typeof CliStop>(),
  captureCliSourceProcessIdentities: stop.capture,
  stopCliSourceAndJudge: stop.judge,
  probeCliSourceSurvivors: stop.probe
}))

let rig: RestTestRig
let rows: AgentStatusIpcPayload[]
const identity = { pid: 4321, platform: 'linux' as const, startTime: 'start' }
const row = (paneKey: string): AgentStatusIpcPayload => ({
  paneKey,
  worktreeId: HOST_TEST_LOCATION.workspaceId,
  agentType: 'codex',
  state: 'working',
  prompt: '',
  connectionId: null,
  receivedAt: 1,
  stateStartedAt: 1,
  providerSession: { key: 'session_id', id: HOST_TEST_THREAD, transcriptPath: '/saved.jsonl' }
})
const sourceHost: CliStop.CliSourceStopHost = {
  rows: () => rows,
  resolvePane: () => ({ ptyId: 'pty-source', connected: true }),
  sleeping: () => false,
  presence: async () => 'live',
  shellForeground: async () => false,
  rootPid: async () => 4321,
  stop: async () => ({ postStopVerified: true }),
  terminateJobAndReport: async () => ({ terminated: false })
}
const cliSourceStop = {
  host: sourceHost,
  workspaceId: HOST_TEST_LOCATION.workspaceId,
  resumeFrom: {
    providerSessionId: HOST_TEST_THREAD,
    cliSource: { workspaceId: HOST_TEST_LOCATION.workspaceId, paneKey: 'pane-source', stopRunningAgent: true }
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  rows = [row('pane-source')]
  stop.capture.mockResolvedValue([identity])
  stop.probe.mockResolvedValue([])
})
afterEach(async () => {
  await rig.dispose()
})

async function adoptedParams() {
  const transcriptPath = join(rig.root, 'rollout.jsonl')
  await writeFile(transcriptPath, [
    JSON.stringify({
      type: 'session_meta',
      payload: { id: HOST_TEST_THREAD, timestamp: '2026-09-06T18:00:00.000Z', cwd: rig.root }
    }),
    JSON.stringify({
      type: 'response_item', timestamp: '2026-09-06T18:00:01.000Z',
      payload: { type: 'message', role: 'user', content: 'terminal history' }
    })
  ].join('\n'))
  return createTestParams(undefined, {
    adopt: { providerHandle: codexProviderHandle(HOST_TEST_THREAD), transcriptPath }
  })
}

it('reserves and saves identities before stop, then imports after exit', async () => {
  const params = await adoptedParams()
  stop.judge.mockImplementation(async () => {
    expect(rig.store.getRecord(HOST_TEST_SESSION)?.adoptionSurvivors).toEqual([identity])
    expect(rig.store.getRecord(HOST_TEST_SESSION)?.providerHandleChain[0]?.origin).toBe('adopted')
    return []
  })
  const result = await rig.host.create(CREATE_TEST_CALLER, params, { cliSourceStop })
  expect(result).toMatchObject({ ok: true, value: { page: {
    items: expect.arrayContaining([expect.objectContaining({
      body: expect.objectContaining({ blocks: [{ type: 'text', text: 'terminal history' }] })
    })])
  } } })
  expect(rig.store.getRecord(HOST_TEST_SESSION)?.adoptionSurvivors).toBeUndefined()
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
})

it('keeps an unproven writer across replay and later re-probes it', async () => {
  const params = await adoptedParams()
  stop.judge.mockResolvedValue([identity])
  expect(await rig.host.create(CREATE_TEST_CALLER, params, { cliSourceStop })).toMatchObject({
    ok: false, refusal: { details: { reason: 'terminalStopUnconfirmed' } }
  })
  expect(rig.store.getRecord(HOST_TEST_SESSION)?.adoptionSurvivors).toEqual([identity])
  expect(await rig.host.create(CREATE_TEST_CALLER, params, { cliSourceStop })).toMatchObject({
    ok: false, refusal: { details: { reason: 'terminalStopUnconfirmed' } }
  })
  expect(stop.judge).toHaveBeenCalledOnce()
  rows = [row('new-pane')]
  const retry = {
    ...params,
    envelope: { ...params.envelope, clientOperationId: hostTestOperationId() }
  }
  expect(await rig.host.create(CREATE_TEST_CALLER, retry, { cliSourceStop })).toMatchObject({
    ok: false, refusal: { details: { reason: 'conversationHeldElsewhere' } }
  })
  expect(stop.probe).not.toHaveBeenCalled()
  rows = []
  const afterExit = {
    ...params,
    envelope: { ...params.envelope, clientOperationId: hostTestOperationId() }
  }
  stop.probe.mockResolvedValue([])
  expect(await rig.host.create(CREATE_TEST_CALLER, afterExit, { cliSourceStop })).toMatchObject({
    ok: true
  })
  expect(stop.probe).toHaveBeenCalledWith([identity])
  expect(stop.judge).toHaveBeenCalledOnce()
  expect(rig.store.getRecord(HOST_TEST_SESSION)?.adoptionSurvivors).toBeUndefined()
})
