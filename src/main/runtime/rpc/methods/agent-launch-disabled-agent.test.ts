/**
 * A launch that names an agent the user turned off is refused before either route runs, against
 * the real durable ledger, so the chat route cannot start it and cannot fall back to a terminal.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLaunchFingerprintInput } from '../../../../shared/agent-launch-operation'
import { AgentSessionRecordStore } from '../../agent-session-record-store'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import {
  CAPABLE_CLIENT,
  methodNamed,
  rpcContext,
  runtimeStub,
  STRUCTURED_PREFERENCE,
  type AgentLaunchRuntimeStub
} from './agent-launch.test-fixture'

const createStructuredSession = vi.fn(async () => ({
  ok: true as const,
  value: { sessionId: 'sess-1', fence: 1 }
}))

vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: () => createStructuredSession()
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')
const AGENT_LAUNCH_REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')

const DISABLED_MESSAGE = 'Agent claude is disabled. Choose an enabled agent.'
const OPERATION_ID = `${Date.now()}-000000000000000000000000000000d1`
const EXISTING = { kind: 'existing', worktree: 'id:wt-7' } as const

let directory: string
let store: AgentSessionRecordStore

function claudeDisabled(chatByDefault: boolean): AgentLaunchRuntimeStub {
  return runtimeStub({
    settings: {
      ...STRUCTURED_PREFERENCE,
      openAgentTabsInChatByDefault: chatByDefault,
      disabledTuiAgents: ['claude']
    }
  })
}

type LaunchParams = AgentLaunchFingerprintInput & { operationId?: string }

function replay(params: LaunchParams, runtime: AgentLaunchRuntimeStub) {
  const parsed = AGENT_LAUNCH_REPLAY.params.safeParse(params)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'invalid')
  }
  return AGENT_LAUNCH_REPLAY.handler(parsed.data, rpcContext(runtime, CAPABLE_CLIENT))
}

function launch(params: LaunchParams, runtime: AgentLaunchRuntimeStub) {
  const parsed = AGENT_LAUNCH.params.safeParse(params)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'invalid')
  }
  return AGENT_LAUNCH.handler(parsed.data, rpcContext(runtime, CAPABLE_CLIENT))
}

function expectNothingCreated(runtime: AgentLaunchRuntimeStub): void {
  expect(createStructuredSession).not.toHaveBeenCalled()
  expect(runtime.createTerminal).not.toHaveBeenCalled()
  expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
}

beforeEach(async () => {
  createStructuredSession.mockClear()
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-disabled-'))
  store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `deps.store` is the only member `agent.launch` reads, and a member it omits throws on call.
  setStructuredAgentSessionHost({ deps: { store } } as unknown as StructuredAgentSessionHost)
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rm(directory, { recursive: true, force: true })
})

describe('a launch of a disabled agent', () => {
  it('is refused with the real reason when the default is a chat, and settles failed', async () => {
    const runtime = claudeDisabled(true)
    const params = { agent: 'claude', target: EXISTING, operationId: OPERATION_ID } as const

    await expect(replay(params, runtime)).rejects.toThrow(DISABLED_MESSAGE)
    expectNothingCreated(runtime)
    const row = store.listOperationRows().find((entry) => entry.operationId === OPERATION_ID)
    expect(row?.outcome).toMatchObject({ status: 'failed', code: DISABLED_MESSAGE })

    // A retry is answered from the record, even once the agent is enabled again.
    const reenabled = runtimeStub({ settings: STRUCTURED_PREFERENCE })
    await expect(replay(params, reenabled)).rejects.toThrow(DISABLED_MESSAGE)
    expectNothingCreated(reenabled)
  })

  it('is refused without an operation id too', async () => {
    const runtime = claudeDisabled(true)
    await expect(launch({ agent: 'claude', target: EXISTING }, runtime)).rejects.toThrow(
      DISABLED_MESSAGE
    )
    expectNothingCreated(runtime)
  })

  it('is refused before a terminal when the default is a terminal', async () => {
    const runtime = claudeDisabled(false)
    await expect(launch({ agent: 'claude', target: EXISTING }, runtime)).rejects.toThrow(
      DISABLED_MESSAGE
    )
    expectNothingCreated(runtime)
  })

  it('is refused before it creates the workspace it would run in', async () => {
    const runtime = claudeDisabled(true)
    await expect(
      launch(
        {
          agent: 'claude',
          target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } }
        },
        runtime
      )
    ).rejects.toThrow(DISABLED_MESSAGE)
    expectNothingCreated(runtime)
  })

  it('leaves an enabled agent alone', async () => {
    const runtime = claudeDisabled(true)
    await expect(launch({ agent: 'codex', target: EXISTING }, runtime)).resolves.toMatchObject({
      outcome: { kind: 'structured', sessionId: 'sess-1' }
    })
    expect(createStructuredSession).toHaveBeenCalledTimes(1)
  })
})
