import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import {
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from '../runtime/structured-agent-session-runtime'
import { acpScriptedChild } from './acp-scripted-child.test-fixture'

let stateDirectory: string | undefined
let operation = 0
const operationId = () => `${Date.now()}-${(++operation).toString(16).padStart(32, '0')}`
const caller = { callerKey: 'scripted-acp-runtime' }

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  if (stateDirectory) {
    await rm(stateDirectory, { recursive: true, force: true })
  }
  stateDirectory = undefined
})

describe.each(['grok', 'opencode'] as const)('%s runtime with a scripted ACP child', (agent) => {
  it('attaches and accepts a send while startup is held, then delivers once the protocol session opens', async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), 'orca-scripted-acp-'))
    const script = acpScriptedChild(agent)()
    const host = await ensureStructuredAgentSessionHost({
      logger: createStructuredAgentSessionLogger(),
      stateDirectory,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => stateDirectory ?? '',
      resolveLaunchArgs: () => [],
      resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
      ...script.deps
    })
    const attach = hostTestAttachParams(null, {
      provider: agent,
      agent,
      providerHandle: undefined,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'folder-1',
        workspaceKind: 'folder'
      },
      accountHome:
        agent === 'grok'
          ? { variable: 'GROK_HOME', path: stateDirectory }
          : { kind: 'opencode', locator: { kind: 'unmanaged' } }
    })
    attach.envelope.clientOperationId = operationId()
    const attached = await host.attach(caller, attach)
    expect(attached).toMatchObject({ ok: true })
    if (!attached.ok) {
      throw new Error(JSON.stringify(attached.refusal))
    }
    const body = hostTestMessage('message during startup')
    const sent = await host.send(caller, {
      body,
      envelope: {
        sessionId: HOST_TEST_SESSION,
        clientOperationId: operationId(),
        expectedRuntimeFence: attached.value.fence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: HOST_TEST_SESSION,
          fields: { body }
        })
      }
    })
    expect(sent).toMatchObject({ ok: true })
    expect(script.prompts()).toEqual([])
    await vi.waitFor(() => expect(script.spawns()).toBe(1))
    script.releaseHandshake()
    await vi.waitFor(() => expect(script.prompts()).toEqual(['message during startup']))
    await host.close(HOST_TEST_SESSION, 'user-close')
    expect(script.closes()).toBe(1)
  })
})
