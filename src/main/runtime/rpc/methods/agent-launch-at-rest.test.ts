import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import {
  createRestTestRig,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { HOST_TEST_NOW } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { RpcContext } from '../core'
import { methodNamed, rpcContext, runtimeStub } from './agent-launch.test-fixture'

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')

// The phone: it renders either surface and sends a new chat's first message itself.
const PHONE: Partial<RpcContext> = {
  clientKind: 'mobile',
  pairedDeviceId: 'device-1',
  clientCapabilities: [
    AGENT_LAUNCH_RUNTIME_CAPABILITY,
    AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY
  ]
}
// The `orca` CLI carries no capability list.
const CLI: Partial<RpcContext> = {}
const SESSION = 'codex_9b1deb4d_3b7d_4bad_9bdd_2b0d7b3dcb6d'

let rig: RestTestRig
beforeEach(async () => {
  // The launch mints its operation id from the wall clock; the rig's host reads a fixed one.
  vi.useFakeTimers({ now: HOST_TEST_NOW, toFake: ['Date'] })
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  setStructuredAgentSessionHost(rig.host)
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  vi.useRealTimers()
})

function launch(caller: Partial<RpcContext>, prompt?: string) {
  const runtime = {
    ...runtimeStub(),
    resolveStructuredAgentSessionCreateIntent: vi.fn(async (params: { envelope: unknown }) => ({
      envelope: params.envelope,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'git-worktree'
      },
      provider: 'codex',
      agent: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/host/.codex' },
      options: { model: 'gpt-5.6-sol', effort: 'medium' },
      runtimeKind: 'native'
    })),
    publishStructuredAgentSessionTab: vi.fn(async () => {})
  }
  const params = AGENT_LAUNCH.params.parse({
    agent: 'codex',
    target: { kind: 'existing', worktree: 'id:wt-7' },
    sessionId: SESSION,
    ...(prompt ? { prompt: { text: prompt, delivery: 'submit' } } : {})
  })
  return AGENT_LAUNCH.handler(params, rpcContext(runtime, caller))
}

it.each([
  { name: 'a bare launch from the phone waits', caller: PHONE, startsAtCreation: false },
  {
    name: 'a launch from the phone with a prompt starts',
    caller: PHONE,
    prompt: 'fix the build',
    startsAtCreation: true
  },
  { name: 'a bare launch from the CLI starts', caller: CLI, startsAtCreation: true }
])('$name', async ({ caller, prompt, startsAtCreation }) => {
  const result = await launch(caller, prompt)

  expect(result.outcome).toMatchObject({ kind: 'structured', sessionId: SESSION })
  expect(rig.store.getRecord(SESSION)).toBeDefined()
  // At rest, nothing is spawned until the chat's first message.
  expect(rig.adapter.acquire.mock.calls.length > 0).toBe(startsAtCreation)
})
