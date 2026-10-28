/**
 * The automation helper hands the whole launch prompt to create, so the chat's first turn is the
 * one that was asked for. This runs the real create prepare/commit code against a host double:
 * only the host, the runtime resolver and the ids are stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHeadlessAutomationStructuredSession } from './headless-automation-session-reuse'

const { sendAgentTurn, hostRef } = vi.hoisted(() => ({
  sendAgentTurn: vi.fn(async () => ({ kind: 'sent', clientMessageId: 'msg-1' })),
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hoisted refs run before the host double's type exists; the registry mock hands it to the create path as-is.
  hostRef: { current: null as unknown }
}))

vi.mock('../runtime/orchestration/send-agent-turn', () => ({ sendAgentTurn }))
vi.mock('../runtime/rpc/methods/agent-launch-terminal-prompt', () => ({
  deliverTerminalAgentLaunchPrompt: vi.fn(async () => true)
}))
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
vi.mock('./runtime-structured-run-observer', () => ({
  structuredAutomationRunHandle: (id: string) => `structured-automation-session:${id}`
}))

type Call = { method: 'host.create' | 'host.attach'; firstMessage?: { clientMessageId: string } }

/** A host that records which create half it was asked for. */
function hostDouble(calls: Call[]) {
  return {
    deps: { store: { getOperationRow: () => null }, agents: {} },
    create: async (
      _caller: unknown,
      params: { envelope: { sessionId: string } },
      options: { firstMessage?: { clientMessageId: string } }
    ) => {
      calls.push({
        method: 'host.create',
        ...(options.firstMessage ? { firstMessage: options.firstMessage } : {})
      })
      return {
        ok: true as const,
        value: {
          sessionId: params.envelope.sessionId,
          fence: 1,
          ...(options.firstMessage
            ? { firstMessage: { clientMessageId: options.firstMessage.clientMessageId } }
            : {})
        }
      }
    },
    attach: async () => {
      calls.push({ method: 'host.attach' })
      return { ok: true as const, value: { sessionId: 'sess-1', fence: 1 } }
    }
  }
}

function runtimeDouble() {
  return {
    ensureStructuredAgentSessionHost: async () => {},
    resolveStructuredAgentSessionCreateIntent: async () => ({
      location: { workspaceId: 'wt-1' },
      provider: 'claude',
      agent: 'claude'
    }),
    publishStructuredAgentSessionTab: async () => {},
    resolveStructuredAgentSessionLocalWorkspacePath: async () => '/tmp/automation-chat'
  }
}

const FIRST_MESSAGE = {
  clientMessageId: 'first-turn',
  body: { kind: 'message', role: 'user', content: [{ type: 'text', text: 'review nonce' }] }
}

describe('headless automation structured create', () => {
  beforeEach(() => {
    sendAgentTurn.mockClear()
  })

  function installHost(calls: Call[]): void {
    hostRef.current = hostDouble(calls)
  }

  it('sends the launch prompt as create’s own first message, never as a later send', async () => {
    const calls: Call[] = []
    installHost(calls)
    const receipt = await createHeadlessAutomationStructuredSession({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create path reads only the resolver and host lift the double provides.
      runtime: runtimeDouble() as never,
      caller: { callerKey: 'automation:run-1' },
      worktreeId: 'wt-1',
      agent: 'claude',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the first message shape is what the create params carry.
      firstMessage: FIRST_MESSAGE as never
    })

    // Why: at-rest create is the only half that carries a first message; attach would drop it.
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'host.create',
      firstMessage: { clientMessageId: 'first-turn' }
    })
    expect(receipt.firstMessage).toEqual({ clientMessageId: 'first-turn' })
    expect(sendAgentTurn).not.toHaveBeenCalled()
  })

  it('keeps the at-rest create for a prompt-less launch', async () => {
    const calls: Call[] = []
    installHost(calls)
    const receipt = await createHeadlessAutomationStructuredSession({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create path reads only the resolver and host lift the double provides.
      runtime: runtimeDouble() as never,
      caller: { callerKey: 'automation:run-2' },
      worktreeId: 'wt-1',
      agent: 'claude',
      withoutPrompt: true
    })

    expect(calls).toEqual([{ method: 'host.create' }])
    expect(receipt.firstMessage).toBeUndefined()
  })
})
