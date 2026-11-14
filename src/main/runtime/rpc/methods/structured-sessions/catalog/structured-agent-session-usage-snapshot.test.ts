import { afterEach, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../../../ipc/desktop-renderer-runtime-capabilities'
import { agentSessionRecordFixture } from '../../../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import {
  call,
  clearStructuredHostStub,
  hostStub
} from '../protocol/structured-agent-session-rpc.test-fixture'
import '../protocol/structured-agent-session-rpc-client.test-fixture'

vi.mock('../../../../agent-session/records/agent-session-execution-runtime', () => ({
  executionBuildHash: '1234567890abcdef'
}))

afterEach(clearStructuredHostStub)

it('preserves heartbeat renewals but rejects a handoff during the held meter read', async () => {
  const record = agentSessionRecordFixture()
  record.lease.claimStatus = 'live'
  record.lease.unreconciled = false
  record.lease.handoffStage = null
  record.lease.ownerProcess = {
    hostId: 'local',
    pid: 4321,
    processStartTimeMs: 100,
    spawnToken: 'private',
    runtime: 'runtime-1'
  }
  let handoff = false
  const meter = { sessionId: record.sessionId, runtimeFence: record.lease.runtimeFence }
  const adapter = {
    readUsageMeter: async () => {
      record.lease.lastRenewedAt += 100
      record.lease.leaseDeadlineAt += 100
      if (handoff) {
        record.lease.ownerProcess = { ...record.lease.ownerProcess!, pid: 5432 }
      }
      return { meter, isCurrent: () => true }
    }
  }
  setStructuredAgentSessionHost(
    Object.assign(hostStub(), {
      sessionAgent: () => 'codex',
      deps: {
        store: { getRecord: () => record },
        agents: { registration: () => ({ adapter }) }
      }
    })
  )
  const read = () =>
    call(
      'agentSession.usageSnapshot',
      { sessionId: record.sessionId },
      {
        clientKind: 'runtime',
        clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES
      },
      { getRuntimeId: () => 'runtime-1' }
    )
  expect(await read()).toMatchObject({
    ok: true,
    result: {
      status: 'ok',
      runtime: { runtimeId: 'runtime-1', buildHash: '1234567890abcdef' },
      meter
    }
  })
  handoff = true
  expect(await read()).toMatchObject({
    ok: true,
    result: { status: 'unknown', reason: 'unavailableOrChanged' }
  })
})
