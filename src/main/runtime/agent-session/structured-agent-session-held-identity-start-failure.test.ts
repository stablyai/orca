import { readTestHostJournal } from '../../native-chat/agent-session-journal/journal-observation.test-support'
import { claudeScriptedChild } from '../../claude/claude-scripted-child.test-fixture'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as TimersPromises from 'node:timers/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readWholeAgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import {
  hostTestAttachParams,
  hostTestMessage,
  HOST_TEST_SESSION as SESSION
} from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { createStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { piScriptedChild } from '../../pi/rpc/pi-scripted-child.test-fixture'
import { codexScriptedChild } from '../../codex/structured/session-lifecycle/codex-scripted-child.test-fixture'
import type { ScriptedAgentChild } from './installation/structured-agent-scripted-child.test-fixture'
import { stopStructuredAgentSessionRuntime } from './structured-agent-session-runtime'
import { ensureTestStructuredAgentSessionHost as ensureStructuredAgentSessionHost } from './records/agent-session-record-store-test-harness'

// The start retry backoff's promise delay must use the fake clock this suite jumps.
vi.mock('node:timers/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof TimersPromises>()),
  // ast-grep-ignore: test-no-real-time-wait -- Backed by the fake setTimeout installed per test.
  setTimeout: (ms?: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
}))

let directory: string | undefined
let operations = 0
const operationId = () => `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`
const caller = { callerKey: 'adapter-start-failure-test' }

beforeEach(() => {
  // Real time still passes, so file and database work settles; waits jump the clock.
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(async () => {
  vi.useRealTimers()
  await stopStructuredAgentSessionRuntime()
  if (directory) {
    await rm(directory, { recursive: true, force: true })
    directory = undefined
  }
})

async function failedStart(
  agent: 'pi' | 'codex' | 'grok' | 'claude',
  script: ScriptedAgentChild,
  unanswered = false
) {
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
  const expectedAttempts = unanswered || agent === 'grok' || agent === 'claude' ? 5 : 1
  const identities = Array.from({ length: expectedAttempts }, () => ({
    entered: Promise.withResolvers<void>(),
    released: Promise.withResolvers<void>()
  }))
  let recording = 0
  const commitProcessIdentity = host.deps.store.commitProcessIdentity.bind(host.deps.store)
  vi.spyOn(host.deps.store, 'commitProcessIdentity').mockImplementation(async (input) => {
    const identity = identities[recording++]
    if (!identity) {
      throw new Error('an unexpected child tried to record its identity')
    }
    const recorded = commitProcessIdentity(input)
    identity.entered.resolve()
    await identity.released.promise
    return await recorded
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
            agent === 'claude'
              ? { variable: 'CLAUDE_CONFIG_DIR', path: root }
              : agent === 'pi'
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
  for (let attempt = 1; attempt <= expectedAttempts; attempt++) {
    // Retries back off 100·2^n ms (800 ms before the fifth spawn); each poll jumps 100 ms.
    await vi.waitFor(
      () => {
        vi.advanceTimersByTime(100)
        expect(script.spawns()).toBe(attempt)
      },
      { timeout: 5_000, interval: 10 }
    )
    const fail = unanswered ? script.exitHandshake : script.failHandshake
    if (!fail) {
      throw new Error('fixture has no unanswered exit')
    }
    const identity = identities[attempt - 1]!
    await identity.entered.promise
    try {
      fail('provider config is invalid: bad key')
    } finally {
      identity.released.resolve()
    }
  }
  const submission = async () => {
    await host.flushStreamedEvents(SESSION)
    return (await readTestHostJournal(host, SESSION)).submissions.find(
      (entry) => entry.clientMessageId === sent.value.clientMessageId
    )
  }
  await vi.waitFor(async () => expect((await submission())?.dispatchState).toBe('rejected'), {
    timeout: 5_000
  })
  const settled = await submission()
  const snapshot = await readTestHostJournal(host, SESSION)
  const failureKind = agent === 'codex' && !unanswered ? 'startFailed' : 'providerStartFailed'
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
  expect(script.spawns()).toBe(expectedAttempts)
}

it('Claude keeps unanswered early exits within five attempts', async () => {
  await failedStart('claude', claudeScriptedChild())
})
it('Codex keeps unanswered early exits within five attempts', async () => {
  await failedStart('codex', codexScriptedChild(), true)
})
it('Pi keeps unanswered early exits within five attempts', async () => {
  await failedStart('pi', piScriptedChild(), true)
})
