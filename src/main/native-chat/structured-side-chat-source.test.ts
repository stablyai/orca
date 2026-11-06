import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolveStructuredSideChatSource } from './structured-side-chat-source'
import {
  createRestTestRig,
  REST_TEST_CALLER,
  type RestTestRig
} from './agent-session-wire/host/testing/structured-agent-session-rest-test-rig'
import {
  hostTestAttachParams,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD
} from './agent-session-wire/host/testing/structured-agent-session-host-test-data'

let rig: RestTestRig
beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  expect((await rig.host.attach(REST_TEST_CALLER, hostTestAttachParams(null))).ok).toBe(true)
})
afterEach(async () => rig.dispose())

function source() {
  return {
    host: rig.host,
    sourceSessionId: HOST_TEST_SESSION,
    sessionId: 'codex_side_child',
    agent: 'codex',
    location: { ...hostTestAttachParams(null).location }
  }
}

it('pins the real source account and provider identity without modifying the main session', () => {
  const before = structuredClone(rig.store.getRecord(HOST_TEST_SESSION))
  const selected = resolveStructuredSideChatSource(source())
  expect(selected.sideChat).toEqual({
    sourceSessionId: HOST_TEST_SESSION,
    sourceProviderSessionId: HOST_TEST_THREAD
  })
  expect(selected.accountHome).toEqual(before?.accountHome)
  expect(rig.store.getRecord(HOST_TEST_SESSION)).toEqual(before)
})

it.each(['own', 'ask', 'auto', 'full-access'] as const)(
  'carries the source %s permission into the independent child',
  async (permissionMode) => {
    const parent = rig.store.getRecord(HOST_TEST_SESSION)!
    await rig.store.replaceSessionOptions({
      sessionId: HOST_TEST_SESSION,
      fence: parent.lease.runtimeFence,
      permissionMode,
      now: rig.clock.now
    })
    const before = structuredClone(rig.store.getRecord(HOST_TEST_SESSION))
    const selected = resolveStructuredSideChatSource(source())
    expect(selected.options).toMatchObject({ permissionMode })
    expect(rig.store.getRecord(HOST_TEST_SESSION)).toEqual(before)
  }
)

it('keeps a floating side chat in the source’s pinned directory', async () => {
  const location = { ...source().location, workspaceId: FLOATING_TERMINAL_WORKTREE_ID }
  const parent = rig.store.getRecord(HOST_TEST_SESSION)!
  const getRecord = rig.store.getRecord.bind(rig.store)
  const read = vi
    .spyOn(rig.store, 'getRecord')
    .mockImplementation((id) =>
      id === HOST_TEST_SESSION
        ? { ...parent, location, launchDirectory: '/original-folder' }
        : getRecord(id)
    )
  try {
    expect(resolveStructuredSideChatSource({ ...source(), location })).toMatchObject({
      hostLaunchDirectory: '/original-folder'
    })
    read.mockImplementation((id) =>
      id === HOST_TEST_SESSION ? { ...parent, location, launchDirectory: undefined } : getRecord(id)
    )
    expect(() => resolveStructuredSideChatSource({ ...source(), location })).toThrow(
      'agent_session_identity_required'
    )
  } finally {
    read.mockRestore()
  }
})

it.each(['workspace', 'host', 'agent', 'self'] as const)(
  'refuses an incompatible %s source',
  (change) => {
    const input = source()
    if (change === 'workspace') {
      input.location.workspaceId = 'another-workspace'
    }
    if (change === 'host') {
      input.location.executionHostId = 'runtime:another-host'
    }
    if (change === 'agent') {
      input.agent = 'claude'
    }
    if (change === 'self') {
      input.sessionId = HOST_TEST_SESSION
    }
    expect(() => resolveStructuredSideChatSource(input)).toThrow()
  }
)
