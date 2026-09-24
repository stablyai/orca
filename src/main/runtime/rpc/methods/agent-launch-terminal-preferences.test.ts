/**
 * The model, effort and mode a terminal launch starts with.
 *
 * A launch's `sessionOptions` carry the picks the user made (the remembered model among them). A
 * structured create has always read them; a terminal launch dropped them, so the same launch got a
 * different model depending on which surface the host chose. Both routes that build a terminal now
 * hand them to the runtime as launch preferences, which the startup plan ranks above configured args.
 */

import { describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import {
  CAPABLE_CLIENT,
  STRUCTURED_PREFERENCE,
  methodNamed,
  rpcContext,
  runtimeStub,
  type AgentLaunchRuntimeStub as RuntimeStub
} from './agent-launch.test-fixture'

vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: async () => ({
    ok: true,
    value: { sessionId: 'sess-1' }
  })
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')

const TERMINAL_ONLY = {}
const EXISTING_LAUNCH = { agent: 'claude', target: { kind: 'existing', worktree: 'id:wt-7' } }
const CREATE_LAUNCH = {
  agent: 'claude',
  target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } }
}
const PICKS = { model: 'opus', effort: 'high' }

async function launch(params: unknown, runtime: RuntimeStub, context: Partial<RpcContext> = {}) {
  const parsed = AGENT_LAUNCH.params.safeParse(params)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'invalid')
  }
  return AGENT_LAUNCH.handler(parsed.data, rpcContext(runtime, { ...CAPABLE_CLIENT, ...context }))
}

function terminalOptions(runtime: RuntimeStub): Record<string, unknown> {
  return runtime.createTerminal.mock.calls[0]?.[1] ?? {}
}

function createArgs(runtime: RuntimeStub): Record<string, unknown> {
  return runtime.createManagedWorktree.mock.calls[0]?.[0] ?? {}
}

describe('a terminal launch into an existing workspace', () => {
  it('starts the agent with the picks the launch carried', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY })

    await launch({ ...EXISTING_LAUNCH, sessionOptions: PICKS }, runtime)

    expect(terminalOptions(runtime)).toMatchObject({ launchPreferences: PICKS })
  })

  it('adds no preferences when the launch carried none', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY })

    await launch(EXISTING_LAUNCH, runtime)

    expect(terminalOptions(runtime)).not.toHaveProperty('launchPreferences')
  })

  it('keeps the picks through a downgrade from structured to terminal', async () => {
    const runtime = runtimeStub({
      settings: STRUCTURED_PREFERENCE,
      createSupport: { supported: false, reason: 'wsl' }
    })

    await launch({ ...EXISTING_LAUNCH, sessionOptions: PICKS }, runtime)

    expect(terminalOptions(runtime)).toMatchObject({ launchPreferences: PICKS })
  })

  it('drops options that are not launch preferences', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY })

    await launch({ ...EXISTING_LAUNCH, sessionOptions: { permissionMode: 'plan' } }, runtime)

    expect(terminalOptions(runtime)).not.toHaveProperty('launchPreferences')
  })
})

describe('a terminal launch that creates its workspace', () => {
  it('starts the startup agent with the picks the launch carried', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY })

    await launch({ ...CREATE_LAUNCH, sessionOptions: PICKS }, runtime)

    expect(createArgs(runtime)).toMatchObject({ startupLaunchPreferences: PICKS })
  })

  it('sends no startup preferences when the launch carried none', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY })

    await launch(CREATE_LAUNCH, runtime)

    expect(createArgs(runtime)).not.toHaveProperty('startupLaunchPreferences')
  })

  it('sends no startup preferences when the workspace gets a chat instead', async () => {
    // The chat reads the same picks from its own create; a startup terminal is not created at all.
    const runtime = runtimeStub({ settings: STRUCTURED_PREFERENCE })

    await launch({ ...CREATE_LAUNCH, sessionOptions: PICKS }, runtime)

    expect(createArgs(runtime)).not.toHaveProperty('startupLaunchPreferences')
  })
})
