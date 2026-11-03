import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as CustomAcpModule from './custom-acp-launch-specs'

vi.mock('./custom-acp-launch-specs', async (importOriginal) => {
  const actual = await importOriginal<typeof CustomAcpModule>()
  return {
    ...actual,
    loadCustomAcpLaunchSpecs: () => [
      actual.customAcpLaunchSpec({
        id: 'custom-reviewer',
        command: 'review-adapter',
        args: [],
        env: {},
        account: { variable: 'REVIEWER_HOME', directory: '/reviewer-account' }
      })
    ]
  }
})

import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from '../runtime/agent-session/structured-agent-session-runtime'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  hostTestAttachParams,
  hostTestMessage,
  HOST_TEST_SESSION
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import { acpScriptedChild } from './acp-scripted-child.test-fixture'

let directory: string | undefined
let sequence = 0
const operationId = () => `${Date.now()}-${(++sequence).toString(16).padStart(32, '0')}`

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('custom ACP runtime registration', () => {
  it('drives a custom-ID chat through the real host, adapter router and journal', async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-custom-host-'))
    const script = acpScriptedChild('custom-reviewer')()
    script.holdHandshakes = false
    const host = await ensureStructuredAgentSessionHost({
      ...script.deps,
      stateDirectory: directory,
      hostId: 'local',
      claimKeyId: 'key-1',
      logger: createStructuredAgentSessionLogger(),
      resolveWorkspacePath: async () => directory!,
      resolveLaunchArgs: () => [],
      resolveClaudeAuthPolicy: () => ({ account: 'managed' })
    })
    const attach = hostTestAttachParams(null, {
      provider: 'custom-reviewer',
      agent: 'custom-reviewer',
      providerHandle: undefined,
      accountHome: { variable: 'REVIEWER_HOME', path: directory },
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'folder-1',
        workspaceKind: 'folder'
      }
    })
    attach.envelope.clientOperationId = operationId()
    const caller = { callerKey: 'custom-adapter-test' }
    const attached = await host.attach(caller, attach)
    if (!attached.ok) {
      throw new Error(attached.refusal.message)
    }
    const body = hostTestMessage('review this change')
    const result = await host.send(caller, {
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
    expect(result).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(script.prompts()).toEqual(['review this change']))
    await host.close(HOST_TEST_SESSION, 'user-close')
    expect(script.closes()).toBe(1)
  })
})
