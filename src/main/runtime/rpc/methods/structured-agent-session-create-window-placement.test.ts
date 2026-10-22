// A chat this machine's window creates is placed by the window's own open, where it reserved the
// chat's place; main's publish of it places nothing. Any other caller's chat main places itself.
import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import { structuredAgentSessionCreateParams } from '../../../../shared/structured-agent-session-create'
import {
  createRestTestRig,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW as NOW
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { DESKTOP_RPC_CALLER, type RpcCallerIdentity } from '../rpc-caller-identity'
import { call, runtimeCalls } from './structured-agent-session-rpc.test-fixture'

const CLIENT = {
  clientId: 'device-1',
  clientKind: 'runtime' as const,
  clientCapabilities: [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY
  ]
}

let rig: RestTestRig

beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  setStructuredAgentSessionHost(rig.host)
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
})

// The transport's caller stamp, which the fixture forwards with the rest of the client.
const create = (client: typeof CLIENT & { caller?: RpcCallerIdentity }) =>
  call(
    'agentSession.create',
    structuredAgentSessionCreateParams({
      sessionId: SESSION,
      worktree: 'id:workspace-1',
      agent: 'codex',
      randomUuid: () => '00000000-0000-0000-0000-0000000000fb',
      now: NOW
    }),
    client
  )

it.each([
  ["this machine's window", { ...CLIENT, caller: DESKTOP_RPC_CALLER }, true],
  ['a paired device', { ...CLIENT, caller: { kind: 'paired-device', deviceId: 'phone-1' } }, false],
  ['a caller the transport did not name', CLIENT, false]
] as const)(
  'a create from %s leaves its chat to the window only when the window made it',
  async (_, client, byWindow) => {
    expect(await create(client)).toMatchObject({ ok: true, result: { ok: true } })

    expect(runtimeCalls.publishStructuredAgentSessionTab).toHaveBeenCalledOnce()
    const published = runtimeCalls.publishStructuredAgentSessionTab?.mock.calls[0]?.[0]
    expect(published).toMatchObject({ sessionId: SESSION, activate: true })
    expect(published?.placedByWindow).toBe(byWindow ? true : undefined)
  }
)
