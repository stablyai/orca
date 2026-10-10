import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RestartOfferWorkspaceProvenance } from '../../../../shared/restart-offer-origin'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { RpcResponse } from '../core'
import { DESKTOP_RPC_CALLER } from '../rpc-caller-identity'
import {
  call,
  hostStub,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

const shortcut = vi.hoisted(() => ({ empty: vi.fn(async () => false) }))
vi.mock('./structured-agent-session-restart-offer-read', () => ({
  restartOffersProvablyEmpty: shortcut.empty
}))

const WORKSPACES: Record<string, RestartOfferWorkspaceProvenance> = {
  mine: { creatorProvenance: { kind: 'paired-device', deviceId: 'device-mine' } },
  theirs: { creatorProvenance: { kind: 'paired-device', deviceId: 'device-theirs' } },
  'host-made': { creatorProvenance: { kind: 'host' } },
  automated: {
    automationProvenance: {
      kind: 'created-by-automation',
      automationId: 'automation-1',
      automationNameSnapshot: 'Nightly',
      automationRunId: 'run-1',
      automationRunTitleSnapshot: 'Nightly',
      createdAt: 1,
      executionTargetType: 'local',
      executionTargetId: 'local',
      projectId: 'project-1'
    }
  }
}
const row = (sessionId: string, workspaceId: string) => ({ sessionId, workspaceId, recordedAt: 1 })
const restartResume = {
  list: vi.fn(async () => [
    row('a', 'mine'),
    row('b', 'theirs'),
    row('c', 'host-made'),
    row('d', 'main-checkout'),
    row('e', 'automated')
  ]),
  listFailures: vi.fn(async () => [row('f', 'theirs')]),
  dismiss: vi.fn(async () => 1),
  dismissListed: vi.fn(async (_listed: unknown, _audience?: unknown) => 1),
  continueAfterRestart: vi.fn(async () => ({
    resumed: [],
    continued: [],
    sessions: [row('a', 'mine'), row('b', 'theirs')],
    failed: [row('f', 'host-made')]
  }))
}
const RUNTIME = {
  restartOfferWorkspaceProvenance: (workspaceId: string) => WORKSPACES[workspaceId]
}

beforeEach(() => {
  setStructuredAgentSessionHost(
    Object.assign(hostStub(), { restartResume, knownAgentIds: () => ['claude', 'codex'] })
  )
})

afterEach(() => {
  setStructuredAgentSessionHost(null)
  vi.clearAllMocks()
})

function rowsOf(result: unknown, key: 'sessions' | 'failed'): unknown[] {
  const value = typeof result === 'object' && result !== null && key in result ? result[key] : []
  return Array.isArray(value) ? value : []
}

/** Each listed row's origin by session, from a reply. */
function origins(response: RpcResponse): Record<string, unknown> {
  const result = response.ok ? response.result : null
  return Object.fromEntries(
    [...rowsOf(result, 'sessions'), ...rowsOf(result, 'failed')].map((entry) =>
      typeof entry === 'object' && entry !== null && 'sessionId' in entry
        ? [entry.sessionId, 'origin' in entry ? entry.origin : undefined]
        : []
    )
  )
}

it('says whose each offer is for the paired desktop asking, by the sidebar rule', async () => {
  const response = await call(
    'agentSession.restartResumable',
    {},
    { ...STRUCTURED_CLIENT, pairedDeviceId: 'device-mine' },
    RUNTIME
  )
  expect(response).toMatchObject({ ok: true })
  expect(origins(response)).toEqual({
    a: 'own',
    b: 'other-device',
    c: 'server-made',
    // No creator record: the sidebar shows it as the asker's, so the offer is theirs too.
    d: 'own',
    e: 'automation',
    f: 'other-device'
  })
})

it.each([
  ['an in-process caller', undefined],
  [
    'its own desktop window',
    { ...STRUCTURED_CLIENT, clientId: 'desktop-renderer', caller: DESKTOP_RPC_CALLER }
  ],
  // The transport's caller identity decides, never the client id it declares.
  ['its desktop window under any client id', { ...STRUCTURED_CLIENT, caller: DESKTOP_RPC_CALLER }]
])("counts the host's own user, as %s, as the owner of what the host made", async (_, client) => {
  const response = await call('agentSession.restartResumable', {}, client, RUNTIME)
  expect(origins(response)).toMatchObject({
    a: 'other-device',
    c: 'own',
    d: 'own',
    e: 'automation'
  })
})

it.each([
  ['a remote caller with no device identity', 'token-1'],
  ['a caller that only declares the desktop window’s client id', 'desktop-renderer']
])('leaves the origin out for %s', async (_, clientId) => {
  const response = await call(
    'agentSession.restartResumable',
    {},
    { ...STRUCTURED_CLIENT, clientId },
    RUNTIME
  )
  expect(origins(response)).toEqual({
    a: undefined,
    b: undefined,
    c: undefined,
    d: undefined,
    e: undefined,
    f: undefined
  })
})

it('forgets listed offers by the interruption the client saw, with sessionIds riding along', async () => {
  const offers = [{ sessionId: SESSION, recordedAt: 1 }]
  const response = await call(
    'agentSession.restartResumableDismiss',
    { sessionIds: [SESSION], offers },
    { ...STRUCTURED_CLIENT, pairedDeviceId: 'device-mine' },
    RUNTIME
  )
  expect(response).toMatchObject({ ok: true, result: { dismissed: 1 } })
  expect(restartResume.dismissListed.mock.lastCall?.[0]).toEqual(offers)
  expect(restartResume.dismiss).not.toHaveBeenCalled()
  expect(origins(response)).toMatchObject({ a: 'own' })
})

// The desktop publishes what a continue leaves; without an origin every remaining row would read as
// not the user's.
it('says whose each remaining offer is in a continue reply', async () => {
  const response = await call(
    'agentSession.restartContinue',
    { sessionIds: [SESSION] },
    { ...STRUCTURED_CLIENT, pairedDeviceId: 'device-mine' },
    RUNTIME
  )
  expect(response).toMatchObject({ ok: true })
  expect(origins(response)).toEqual({ a: 'own', b: 'other-device', f: 'server-made' })
})
