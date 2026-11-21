/** Exercise RPC authorization, parsing and all surface factories; structured creates must omit startupAgent while legacy worktree.create retains its terminal contract. */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import type { RpcContext } from '../../core'
import {
  CAPABLE_CLIENT,
  methodNamed,
  rpcContext,
  runtimeStub,
  type AgentLaunchRuntimeStub as RuntimeStub
} from './agent-launch.test-fixture'

/** Include refusal replies so the fixture can exercise structured-to-terminal downgrade. */
type StructuredCreateReply =
  | { ok: true; value: { sessionId: string } }
  | { ok: false; refusal: { code: string; message: string } }

const createStructuredSession = vi.fn(
  async (_args: Record<string, unknown>): Promise<StructuredCreateReply> => ({
    ok: true,
    value: { sessionId: 'sess-1' }
  })
)

vi.mock('../structured-sessions/creation/structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: (args: Record<string, unknown>) =>
    createStructuredSession(args)
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
await import('../workspaces/worktree')

const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')

function parseLaunch(params: unknown) {
  return AGENT_LAUNCH.params.safeParse(params)
}

async function launch(
  params: unknown,
  runtime: RuntimeStub,
  context: Partial<RpcContext> = CAPABLE_CLIENT
) {
  const parsed = parseLaunch(params)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'invalid')
  }
  return AGENT_LAUNCH.handler(parsed.data, rpcContext(runtime, context))
}

const CREATE_LAUNCH = {
  agent: 'claude',
  target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } }
}

beforeEach(() => {
  createStructuredSession.mockClear()
})

describe('the worktree factory', () => {
  it('aborts the setup wait when its bounded timeout expires', async () => {
    vi.useFakeTimers()
    try {
      const runtime = runtimeStub({
        setupReceipt: {
          startupPolicy: 'wait-for-setup',
          state: 'running',
          terminalHandle: 'setup-1'
        }
      })
      let setupSignal: AbortSignal | undefined
      runtime.waitForSetupTerminalCompletion.mockImplementation(
        (_handle, signal) =>
          new Promise<{ exitCode: number | null }>((_resolve, reject) => {
            setupSignal = signal
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
      )

      const result = await (async () => {
        const pending = launch(CREATE_LAUNCH, runtime)
        await vi.runAllTimersAsync()
        return pending
      })()

      expect(result.outcome.kind).toBe('structured')
      expect(setupSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
