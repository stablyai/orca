// A Codex start has no per-step deadline: a slow `initialize` still delivers the held message, and
// one that never answers is ended by the start's own overall limit ("never finished starting").

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { codexScriptedChild } from '../codex/codex-scripted-child.test-fixture'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import {
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { recordAgentSessionStartup } from '../observability/agent-session-instrumentation'
import { STRUCTURED_AGENT_SESSION_STARTUP_CEILING_MS } from '../native-chat/agent-session-wire/structured-agent-session-startup-attempt-contract'
import { readWholeAgentSessionFailureFact } from '../../shared/agent-session-failure'
import type { ScriptedAgentChild } from './structured-agent-scripted-child.test-fixture'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

vi.mock('../observability/agent-session-instrumentation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordAgentSessionStartup: vi.fn()
}))

let root: string | undefined
const caller = { callerKey: 'codex-start-deadline-test' }
let operation = 0

beforeEach(() => {
  // Real time still passes, so file and database work settles; the test jumps the clock.
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  })
  vi.mocked(recordAgentSessionStartup).mockClear()
})

afterEach(async () => {
  vi.useRealTimers()
  await stopStructuredAgentSessionRuntime()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

function envelope(method: string, fence: number, fields: Record<string, unknown>) {
  return {
    sessionId: HOST_TEST_SESSION,
    clientOperationId: `${Date.now()}-${(++operation).toString(16).padStart(32, '0')}`,
    expectedRuntimeFence: fence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: HOST_TEST_SESSION,
      fields
    })
  }
}

async function chatHoldingAMessage(child: ScriptedAgentChild) {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-start-deadline-'))
  const host = await ensureStructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => root ?? '',
    resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
    resolveLaunchArgs: () => [],
    ...child.deps
  })
  const attach = hostTestAttachParams(null, { providerHandle: undefined })
  attach.envelope.clientOperationId = `${Date.now()}-${'d'.repeat(32)}`
  const attached = await host.attach(caller, attach)
  if (!attached.ok) {
    throw new Error(JSON.stringify(attached.refusal))
  }
  const body = hostTestMessage('held through a slow Codex start')
  const sent = await host.send(caller, {
    envelope: envelope('agentSession.send', attached.value.fence, { body }),
    body
  })
  expect(sent.ok).toBe(true)
  return host
}

function startupOutcomes(): string[] {
  return vi.mocked(recordAgentSessionStartup).mock.calls.map(([startup]) => startup.outcome)
}

it('delivers the held message to a Codex that answers initialize after a minute', async () => {
  const child = codexScriptedChild()
  await chatHoldingAMessage(child)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(child.closes()).toBe(0)

  child.releaseHandshake()
  await vi.waitFor(() => expect(child.prompts()).toEqual(['held through a slow Codex start']))
  expect(child.spawns()).toBe(1)
  expect(startupOutcomes()).toEqual(['ready'])
})

it('fails the held message as never finished starting when the start passes its overall limit', async () => {
  const child = codexScriptedChild()
  const host = await chatHoldingAMessage(child)
  await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_STARTUP_CEILING_MS - 1_000)
  expect(child.closes()).toBe(0)
  await vi.advanceTimersByTimeAsync(1_000)

  await vi.waitFor(async () => {
    await host.flushStreamedEvents(HOST_TEST_SESSION)
    const [held] = (await host.journalSnapshot(HOST_TEST_SESSION)).submissions
    expect(held?.dispatchState).toBe('rejected')
    expect(readWholeAgentSessionFailureFact(held?.rejection)).toMatchObject({ kind: 'hostStopped' })
  })
  await vi.waitFor(() => expect(child.closes()).toBe(1))
  expect(child.prompts()).toEqual([])
  expect(child.spawns()).toBe(1)
})
