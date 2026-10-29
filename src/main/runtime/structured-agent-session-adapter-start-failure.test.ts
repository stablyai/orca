import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readWholeAgentSessionFailureFact } from '../../shared/agent-session-failure'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import {
  hostTestAttachParams,
  hostTestMessage,
  HOST_TEST_SESSION as SESSION
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { piScriptedChild } from '../pi/pi-scripted-child.test-fixture'
import { codexScriptedChild } from '../codex/codex-scripted-child.test-fixture'
import { acpScriptedChild } from '../acp/acp-scripted-child.test-fixture'
import type { ScriptedAgentChild } from './structured-agent-scripted-child.test-fixture'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

let directory: string | undefined
let operations = 0
const operationId = () => `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`
const caller = { callerKey: 'adapter-start-failure-test' }

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  if (directory) {
    await rm(directory, { recursive: true, force: true })
    directory = undefined
  }
})

async function failedStart(agent: 'pi' | 'codex' | 'grok', script: ScriptedAgentChild) {
  directory = await mkdtemp(join(tmpdir(), 'orca-adapter-start-failure-'))
  const root = directory
  const host = await ensureStructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => root,
    resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
    resolveLaunchArgs: () => [],
    resolveEnvironment: async () => ({ PATH: '' }),
    ...script.deps
  })
  const params = hostTestAttachParams(
    null,
    agent === 'codex'
      ? { providerHandle: undefined }
      : {
          provider: agent,
          agent,
          providerHandle: undefined,
          accountHome:
            agent === 'pi'
              ? { variable: 'PI_CODING_AGENT_DIR', path: root }
              : { variable: 'GROK_HOME', path: root },
          location: {
            executionHostId: 'local',
            wslDistro: null,
            workspaceId: 'folder-1',
            workspaceKind: 'folder'
          }
        }
  )
  params.envelope.clientOperationId = operationId()
  const attached = await host.create(caller, params)
  if (!attached.ok) {
    throw new Error(JSON.stringify(attached.refusal))
  }
  const body = hostTestMessage('held during start')
  const sent = await host.send(caller, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: operationId(),
      expectedRuntimeFence: attached.value.fence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
  if (!sent.ok) {
    throw new Error(JSON.stringify(sent.refusal))
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    // Retries back off 100·2^n ms (800 ms before the fifth spawn); the 1 s default leaves no room under load.
    await vi.waitFor(() => expect(script.spawns()).toBe(attempt), { timeout: 5_000 })
    script.failHandshake('provider config is invalid: bad key')
  }
  const submission = async () => {
    await host.flushStreamedEvents(SESSION)
    return (await host.journalSnapshot(SESSION)).submissions.find(
      (entry) => entry.clientMessageId === sent.value.clientMessageId
    )
  }
  await vi.waitFor(async () => expect((await submission())?.dispatchState).toBe('rejected'), {
    timeout: 5_000
  })
  const settled = await submission()
  const snapshot = await host.journalSnapshot(SESSION)
  const failureKind = agent === 'codex' ? 'startFailed' : 'providerStartFailed'
  expect(readWholeAgentSessionFailureFact(settled?.rejection)).toMatchObject({
    kind: failureKind,
    detail: { text: 'provider config is invalid: bad key' }
  })
  expect(
    snapshot.items.filter(
      (item) =>
        item.body.kind === 'status' &&
        readWholeAgentSessionFailureFact(item.body.failure)?.kind === failureKind
    )
  ).toHaveLength(1)
  expect(script.prompts()).toEqual([])
  expect(script.spawns()).toBe(5)
}

it('Pi records one failure without dispatch after a failed start', async () => {
  await failedStart('pi', piScriptedChild())
})
it('Codex records one failure without dispatch after a failed start', async () => {
  await failedStart('codex', codexScriptedChild())
})
it('ACP records one failure without dispatch after a failed start', async () => {
  await failedStart('grok', acpScriptedChild('grok')())
})
