import { agentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/agent-session-runtime-capabilities'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/agent-session-create-capabilities'
import { structuredAgentSessionCreateParams } from '../../../../shared/agent-session/structured-agent-session-create'
import {
  createRestTestRig,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW as NOW
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { call } from './structured-agent-session-rpc.test-fixture'
import { resetStructuredAgentSessionClosesBeforeCreateForTests } from './structured-agent-session-close-before-create'

const mocks = vi.hoisted(() => ({ layoutOwnerIsMain: true }))
vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))

const CLIENT = {
  clientId: 'device-1',
  clientKind: 'runtime' as const,
  clientCapabilities: [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY
  ]
}

let rig: RestTestRig
let raw: { worktreeId: string; tabId: string } | null = null
const retireTab = vi.fn(() => {
  raw = null
  return true
})

beforeEach(async () => {
  mocks.layoutOwnerIsMain = true
  resetStructuredAgentSessionClosesBeforeCreateForTests()
  retireTab.mockClear()
  raw = null
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  setStructuredAgentSessionHost(rig.host)
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  vi.restoreAllMocks()
})

function createParams() {
  return structuredAgentSessionCreateParams({
    sessionId: SESSION,
    worktree: 'id:workspace-1',
    agent: 'codex',
    randomUuid: () => '00000000-0000-0000-0000-0000000000fa',
    now: NOW
  })
}

const create = (overrides: Record<string, unknown> = {}) =>
  call('agentSession.create', createParams(), CLIENT, {
    retireStructuredAgentSessionTabFromSnapshot: retireTab,
    currentLocalStructuredSessionPresentation: () => raw,
    removeCapturedStructuredSessionSavedTabs: vi.fn(),
    ...overrides
  })
const close = () =>
  call('agentSession.close', { sessionId: SESSION }, CLIENT, {
    currentLocalStructuredSessionPresentation: () => raw,
    captureStructuredAgentSessionPresentation: () => ({ raw, saved: [] }),
    retireStructuredAgentSessionTabFromSnapshot: retireTab,
    removeCapturedStructuredSessionSavedTabs: vi.fn()
  })

const refusedAsClosed = {
  ok: true,
  result: {
    ok: false,
    refusal: {
      code: 'agent_session_operation_invalid',
      message: 'The chat was closed before it was created.'
    }
  }
}

describe('a close that reaches main before its create', () => {
  it('a close fences pending creates with either layout owner', async () => {
    mocks.layoutOwnerIsMain = false
    await close()
    mocks.layoutOwnerIsMain = true

    expect(await create()).toMatchObject(refusedAsClosed)
  })
})

it('a recorded create answers from its record, not from support asked again', async () => {
  expect(await create()).toMatchObject({ ok: true, result: { ok: true } })
  expect(rig.store.getRecord(SESSION)).not.toBeNull()
  // The CLI went missing and the Setup observer is gone; neither decides an operation already run.
  const changed = {
    getSetupRun: () => undefined,
    resolveStructuredAgentSessionCreateIntent: vi.fn(async () => {
      throw agentSessionRefusalError('structured_agent_session_unsupported', {
        reason: 'hostUnsupported'
      })
    })
  }
  const retry = (params = createParams()) => call('agentSession.create', params, CLIENT, changed)
  expect(await retry()).toMatchObject({ ok: true, result: { ok: true, replayed: true } })
  expect(changed.resolveStructuredAgentSessionCreateIntent).not.toHaveBeenCalled()

  const refused = (code: string) => ({ ok: true, result: { ok: false, refusal: { code } } })
  const reused = structuredAgentSessionCreateParams({
    sessionId: SESSION,
    worktree: 'id:workspace-1',
    agent: 'codex',
    firstMessage: {
      clientMessageId: 'another',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Another' }] }
    },
    randomUuid: () => '00000000-0000-0000-0000-0000000000fa',
    now: NOW
  })
  expect(await retry(reused)).toMatchObject(refused('agent_session_operation_conflict'))

  const recorded = rig.store.getOperationRow
  vi.spyOn(rig.store, 'getOperationRow').mockImplementation((...key) => {
    const row = recorded(...key)
    return row && { ...row, outcome: { status: 'unknown' } }
  })
  expect(await retry()).toMatchObject(refused('agent_session_operation_unknown'))
  expect(changed.resolveStructuredAgentSessionCreateIntent).not.toHaveBeenCalled()
})
