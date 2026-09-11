import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import { projectSessionTabsForContext } from './session-tabs-inventory'
import {
  call,
  clearStructuredHostStub,
  envelope,
  hostCalls,
  installStructuredHostStub,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

const FIELDS = {
  worktree: 'id:workspace-1',
  agent: 'codex' as const,
  launchOrigin: 'work-item-start' as const
}

const SETTINGS = {
  getClientSettings: () => ({
    experimentalStructuredNativeChat: false,
    workItemStartPromptDelivery: 'submit-after-ready'
  })
}

function createParams() {
  return {
    envelope: envelope({
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.create',
        sessionId: SESSION,
        fields: FIELDS
      })
    }),
    ...FIELDS
  }
}

beforeEach(() => {
  installStructuredHostStub()
})

afterEach(() => {
  clearStructuredHostStub()
})

describe('Web Work Item Start authority', () => {
  it('derives launch authority from the paired runtime that created the worktree', async () => {
    const client = {
      ...STRUCTURED_CLIENT,
      clientId: 'device-token',
      pairedDeviceId: 'device-web'
    }
    const runtime = {
      ...SETTINGS,
      showManagedWorktree: async () => ({
        id: 'workspace-1',
        creatorProvenance: { kind: 'paired-device' as const, deviceId: 'device-web' }
      })
    }

    await expect(
      call('agentSession.createSupport', FIELDS, client, runtime)
    ).resolves.toMatchObject({ ok: true, result: { supported: true } })
    await expect(
      call('agentSession.create', createParams(), client, runtime)
    ).resolves.toMatchObject({ ok: true, result: { ok: true } })
    expect(hostCalls.attach).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        launchOrigin: 'work-item-start',
        launchAuthority: { kind: 'paired-device', deviceId: 'device-web' }
      })
    )

    await expect(
      call(
        'agentSession.createSupport',
        FIELDS,
        { ...client, pairedDeviceId: 'device-other' },
        runtime
      )
    ).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('structured_agent_session_unsupported') }
    })
  })

  it('fails closed before adoption when the durable session or selector is not authoritative', async () => {
    const client = { ...STRUCTURED_CLIENT, pairedDeviceId: 'device-other' }
    hostCalls.getRecord.mockReturnValue({
      launchOrigin: 'work-item-start',
      launchAuthority: { kind: 'paired-device', deviceId: 'device-owner' }
    })
    const showManagedWorktree = vi.fn(async () => ({
      id: 'workspace-1',
      creatorProvenance: { kind: 'paired-device' as const, deviceId: 'device-other' }
    }))

    for (const [method, input] of [
      ['agentSession.createSupport', { ...FIELDS, sessionId: SESSION }],
      ['agentSession.create', createParams()]
    ] as const) {
      await expect(
        call(method, input, client, { ...SETTINGS, showManagedWorktree })
      ).resolves.toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('structured_agent_session_unsupported') }
      })
    }
    expect(showManagedWorktree).not.toHaveBeenCalled()
    expect(hostCalls.attach).not.toHaveBeenCalled()

    hostCalls.getRecord.mockReturnValue(null)
    showManagedWorktree.mockRejectedValue(new Error('selector_ambiguous'))
    await expect(
      call('agentSession.createSupport', FIELDS, client, { ...SETTINGS, showManagedWorktree })
    ).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('selector_ambiguous') }
    })
    expect(hostCalls.attach).not.toHaveBeenCalled()
  })

  it('projects a Draft session only to its creating paired runtime', () => {
    hostCalls.getRecord.mockReturnValue({
      launchOrigin: 'work-item-start',
      launchAuthority: { kind: 'paired-device', deviceId: 'device-owner' }
    })
    const snapshot = {
      worktree: 'workspace-1',
      publicationEpoch: 'epoch-1',
      snapshotVersion: 1,
      activeGroupId: 'group-1',
      activeTabId: `agent-session:${SESSION}`,
      activeTabType: 'agent-session' as const,
      tabs: [
        {
          id: `agent-session:${SESSION}`,
          type: 'agent-session' as const,
          sessionId: SESSION,
          agent: 'codex' as const,
          title: 'Codex',
          isActive: true
        }
      ]
    }
    const context = {
      runtime: SETTINGS as never,
      clientKind: 'runtime' as const,
      clientCapabilities: STRUCTURED_CLIENT.clientCapabilities
    }

    expect(
      projectSessionTabsForContext(snapshot, { ...context, pairedDeviceId: 'device-owner' }).tabs
    ).toHaveLength(1)
    expect(
      projectSessionTabsForContext(snapshot, { ...context, pairedDeviceId: 'device-other' }).tabs
    ).toEqual([])
  })
})
