import { describe, expect, it, vi } from 'vitest'
import { CreateParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import { structuredAgentSessionCreateParams } from '../../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-create'
import {
  prepareStructuredAgentSessionCreateForWorktree,
  structuredAgentSessionCreateIntentFingerprint
} from './structured-agent-session-create'
import { OrcaRuntimeWithGetStructuredAgentSessionCreateSupport } from '../../../../session-tabs/chat/structured-session-create-support'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host/execution-host'
import type { AgentSessionAccountHome } from '../../../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { StructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import type { StructuredAgentSessionCreateIntentInput } from '../../../../agent-session/ownership/structured-agent-session-create-adoption'

const FIXED_UUID = '11111111-2222-3333-4444-555555555555'
const CLAUDE_HOME: AgentSessionAccountHome = {
  variable: 'CLAUDE_CONFIG_DIR',
  path: '/Users/me/.claude'
}

function createResumeParams(closingPaneKeys?: readonly string[]) {
  return structuredAgentSessionCreateParams({
    sessionId: 'chat-session-1',
    worktree: 'id:folder:ext-vol',
    agent: 'claude',
    resumeFrom: {
      providerSessionId: 'provider-session-1',
      ...(closingPaneKeys ? { closingPaneKeys } : {})
    },
    randomUuid: () => FIXED_UUID,
    now: 1700000000000
  })
}

describe('structured agent session create closingPaneKeys', () => {
  it('accepts resumeFrom.closingPaneKeys in CreateParams and matches client/host fingerprints', () => {
    const withClosing = createResumeParams(['tab-1:leaf-1'])
    const withoutClosing = createResumeParams()

    const parsed = CreateParams.parse(withClosing)
    expect('worktree' in parsed && parsed.resumeFrom?.closingPaneKeys).toEqual(['tab-1:leaf-1'])
    expect(structuredAgentSessionCreateIntentFingerprint(withClosing)).toBe(
      withClosing.envelope.payloadFingerprint
    )
    expect(withClosing.envelope.payloadFingerprint).not.toBe(
      withoutClosing.envelope.payloadFingerprint
    )
  })

  it('grants allowClosingPaneKeys only for at-rest creates without a firstMessage', async () => {
    const capturedInputs: StructuredAgentSessionCreateIntentInput[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: prepareStructuredAgentSessionCreateForWorktree only reads store.getOperationRow here.
    const host = {
      deps: {
        store: {
          getOperationRow: vi.fn(() => null)
        },
        agents: {}
      }
    } as unknown as StructuredAgentSessionHost
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: prepareStructuredAgentSessionCreateForWorktree only calls resolveStructuredAgentSessionCreateIntent here.
    const runtime = {
      resolveStructuredAgentSessionCreateIntent: vi.fn(
        async (input: StructuredAgentSessionCreateIntentInput) => {
          capturedInputs.push(input)
          return {
            envelope: { ...input.envelope, expectedRuntimeFence: null, payloadFingerprint: '' },
            location: {
              executionHostId: LOCAL_EXECUTION_HOST_ID,
              wslDistro: null,
              workspaceId: 'folder:ext-vol',
              workspaceKind: 'folder' as const
            },
            provider: input.agent,
            agent: input.agent,
            accountHome: CLAUDE_HOME,
            runtimeKind: 'native' as const
          }
        }
      )
    } as unknown as OrcaRuntimeService

    const base = createResumeParams(['tab-1:leaf-1'])
    await prepareStructuredAgentSessionCreateForWorktree({
      runtime,
      ensureHost: async () => host,
      envelope: base.envelope,
      worktree: base.worktree,
      agent: base.agent,
      caller: { callerKey: 'device:win-1' },
      resumeFrom: base.resumeFrom,
      atRest: true
    })
    await prepareStructuredAgentSessionCreateForWorktree({
      runtime,
      ensureHost: async () => host,
      envelope: base.envelope,
      worktree: base.worktree,
      agent: base.agent,
      caller: { callerKey: 'device:win-1' },
      resumeFrom: base.resumeFrom,
      atRest: false
    })
    await prepareStructuredAgentSessionCreateForWorktree({
      runtime,
      ensureHost: async () => host,
      envelope: base.envelope,
      worktree: base.worktree,
      agent: base.agent,
      caller: { callerKey: 'device:win-1' },
      resumeFrom: base.resumeFrom,
      atRest: true,
      firstMessage: {
        clientMessageId: 'msg-1',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
      }
    })

    expect(capturedInputs.map((input) => input.allowClosingPaneKeys === true)).toEqual([
      true,
      false,
      false
    ])
  })

  it('forwards closingPaneKeys to assertStructuredAdoptionTerminalWritersExited only when allowClosingPaneKeys is true', async () => {
    const writerCalls: (readonly string[] | undefined)[] = []
    const stopAfterWriters = new Error('stop_after_writers')
    // Prototype-backed so the real assertResumeWritersExited forwards into the recorded writer check.
    const fakeRuntime = Object.assign(
      Object.create(OrcaRuntimeWithGetStructuredAgentSessionCreateSupport.prototype),
      {
        getStructuredAgentSessionCreateSupport: vi.fn(async () => ({ supported: true })),
        accounts: { prepareHostAgentLaunch: vi.fn(async () => undefined) },
        requireStore: () => ({ getSettings: () => ({}) }),
        structuredAgentLaunchEnv: () => ({}),
        resolveStructuredAgentSessionLocation: vi.fn(async () => ({
          executionHostId: LOCAL_EXECUTION_HOST_ID,
          wslDistro: null,
          workspaceId: 'folder:ext-vol',
          workspaceKind: 'folder' as const
        })),
        requireRegisteredStructuredAgent: () => ({
          handleTransport: 'stdio',
          agent: 'claude'
        }),
        assertStructuredAdoptionTerminalWritersExited: vi.fn(
          async (
            _agent: string,
            _providerSessionId: string,
            closingPaneKeys?: readonly string[]
          ) => {
            writerCalls.push(closingPaneKeys)
            throw stopAfterWriters
          }
        )
      }
    )

    const proto: unknown = OrcaRuntimeWithGetStructuredAgentSessionCreateSupport.prototype
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: invokes protected resolveStructuredAgentSessionIntent directly to verify writer-check forwarding.
    const { resolveStructuredAgentSessionIntent: resolveIntent } = proto as {
      resolveStructuredAgentSessionIntent: (
        input: StructuredAgentSessionCreateIntentInput,
        resolveAccountHome: () => AgentSessionAccountHome
      ) => Promise<unknown>
    }

    const params = createResumeParams(['tab-1:leaf-1'])
    await expect(
      resolveIntent.call(
        fakeRuntime,
        {
          envelope: params.envelope,
          worktree: params.worktree,
          agent: 'claude',
          resumeFrom: params.resumeFrom,
          allowClosingPaneKeys: true
        },
        () => CLAUDE_HOME
      )
    ).rejects.toBe(stopAfterWriters)

    await expect(
      resolveIntent.call(
        fakeRuntime,
        {
          envelope: params.envelope,
          worktree: params.worktree,
          agent: 'claude',
          resumeFrom: params.resumeFrom
        },
        () => CLAUDE_HOME
      )
    ).rejects.toBe(stopAfterWriters)

    expect(writerCalls).toEqual([['tab-1:leaf-1'], undefined])
  })
})
