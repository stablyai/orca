/**
 * `agent.launch` makes a chat only for a caller that can show it. `agent.launch.v2` vouches for
 * Claude and Codex chats; any other agent's chat needs the client to read it, by the rule tabs and
 * restart offers use, else it gets a terminal. The host's own callers (CLI, orchestration over the
 * runtime socket) carry no capability list and are unaffected. With the structured-chat setting
 * off, every agent, Grok included, opens as a terminal.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { RpcContext } from '../core'
import {
  CAPABLE_CLIENT,
  methodNamed,
  rpcContext,
  runtimeStub,
  STRUCTURED_PREFERENCE
} from './agent-launch.test-fixture'

const createStructuredSession = vi.fn(async (_args: Record<string, unknown>) => ({
  ok: true as const,
  value: { sessionId: 'sess-1' }
}))

vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: (args: Record<string, unknown>) =>
    createStructuredSession(args)
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')

async function launchInto(
  agent: string,
  context: Partial<RpcContext>,
  settings?: Record<string, unknown>
) {
  const runtime = runtimeStub(settings ? { settings } : {})
  const parsed = AGENT_LAUNCH.params.safeParse({
    agent,
    target: { kind: 'existing', worktree: 'id:wt-7' }
  })
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'invalid')
  }
  const result = await AGENT_LAUNCH.handler(parsed.data, rpcContext(runtime, context))
  return { result, runtime }
}

beforeEach(() => {
  createStructuredSession.mockClear()
})

describe('a launch the caller cannot show as a chat', () => {
  it('opens Grok as a terminal for a client that reads only Claude and Codex chats', async () => {
    const { result, runtime } = await launchInto('grok', CAPABLE_CLIENT)
    expect(result.outcome).toMatchObject({ kind: 'terminal', handle: 'term_1' })
    expect(result.receipt).toMatchObject({ mode: 'terminal', preferred: 'structured' })
    expect(createStructuredSession).not.toHaveBeenCalled()
    expect(runtime.createTerminal).toHaveBeenCalledTimes(1)
  })

  it('still opens Claude and Codex as chats for that client', async () => {
    for (const agent of ['claude', 'codex']) {
      const { result } = await launchInto(agent, CAPABLE_CLIENT)
      expect(result.outcome).toMatchObject({ kind: 'structured' })
    }
  })

  it('opens Grok as a chat for a client that reads registered agents', async () => {
    const { result, runtime } = await launchInto('grok', {
      ...CAPABLE_CLIENT,
      clientCapabilities: [
        ...(CAPABLE_CLIENT.clientCapabilities ?? []),
        STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
        STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
      ]
    })
    expect(result.outcome).toMatchObject({ kind: 'structured', sessionId: 'sess-1' })
    expect(runtime.createTerminal).not.toHaveBeenCalled()
  })

  it("opens Grok as a chat for the host's own callers, which carry no capability list", async () => {
    const { result } = await launchInto('grok', {})
    expect(result.outcome).toMatchObject({ kind: 'structured', sessionId: 'sess-1' })
  })
})

describe('Grok with the structured-chat setting off', () => {
  it('opens as a terminal for every caller, as Claude and Codex do', async () => {
    const off = { ...STRUCTURED_PREFERENCE, experimentalStructuredNativeChat: false }
    for (const agent of ['grok', 'claude']) {
      const { result, runtime } = await launchInto(agent, {}, off)
      expect(result.outcome).toMatchObject({ kind: 'terminal' })
      expect(result.receipt).toMatchObject({ mode: 'terminal', reason: 'user_default' })
      expect(runtime.createTerminal).toHaveBeenCalledTimes(1)
    }
    expect(createStructuredSession).not.toHaveBeenCalled()
  })
})
