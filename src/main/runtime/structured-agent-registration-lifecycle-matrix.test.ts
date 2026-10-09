// Every agent this build registers follows the same startup and Stop rules, driven through its own
// real adapter, the shipped runtime, host, store and journal, with only the provider child scripted.
// Iterates the runtime's registration list, so an agent registered later fails here until it has a
// scripted child, rather than going untested.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type { AgentJournalSubmission } from '../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { ACP_LAUNCH_SPECS } from '../acp/acp-launch-specs'
import { acpScriptedChild } from '../acp/acp-scripted-child.test-fixture'
import { claudeScriptedChild } from '../claude/claude-scripted-child.test-fixture'
import { codexScriptedChild } from '../codex/codex-scripted-child.test-fixture'
import type { StructuredAgentDefinition } from '../native-chat/agent-session-wire/structured-agent-definition'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import {
  hostTestAttachParams,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { piScriptedChild } from '../pi/pi-scripted-child.test-fixture'
import { sendStructuredWorkerPreamble } from './rpc/methods/orchestration-structured-worker-session'
import type {
  ScriptedAgentChild,
  ScriptedAgentChildFactory
} from './structured-agent-scripted-child.test-fixture'
import { STRUCTURED_AGENT_RUNTIME_REGISTRATIONS } from './structured-agent-runtime-registrations'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime,
  type StructuredAgentSessionRuntimeDeps
} from './structured-agent-session-runtime'

// Every ACP agent runs the one ACP adapter, so each gets the ACP child; any other kind needs its own.
const SCRIPTED_CHILDREN: Readonly<Record<string, ScriptedAgentChildFactory>> = {
  claude: claudeScriptedChild,
  codex: codexScriptedChild,
  ...Object.fromEntries(ACP_LAUNCH_SPECS.map(({ agent }) => [agent, acpScriptedChild(agent)])),
  pi: piScriptedChild
}

const SESSION = 'matrix-session'
const CALLER = { callerKey: 'matrix-client' }

let root: string | null = null
let operations = 0

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

const eventually = (assertion: () => void | Promise<void>): Promise<void> =>
  vi.waitFor(assertion, { timeout: 10_000 })

/** The runtime admits operation ids against its own clock. */
const operationId = (): string => `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`

function accountHome(definition: StructuredAgentDefinition, home: string): AgentSessionAccountHome {
  return definition.accountLocatorKind === 'opencode'
    ? { kind: 'opencode', locator: { kind: 'unmanaged' } }
    : { variable: definition.accountHomeVariable, path: join(home, definition.agent) }
}

type Chat = {
  host: StructuredAgentSessionHost
  child: ScriptedAgentChild
  fence: () => number
  send: (text: string) => Promise<string>
  stop: () => Promise<void>
  submission: (clientMessageId: string) => Promise<AgentJournalSubmission | undefined>
  phase: () => 'starting' | 'ready' | undefined
}

/** A new chat of `definition`'s agent, attached while its first handshake is held. */
async function openChat(
  definition: StructuredAgentDefinition,
  runtime: Partial<StructuredAgentSessionRuntimeDeps> = {}
): Promise<Chat> {
  const factory = SCRIPTED_CHILDREN[definition.agent]
  if (!factory) {
    throw new Error(`${definition.agent} is registered but has no scripted child for this matrix`)
  }
  const child = factory()
  root = await mkdtemp(join(tmpdir(), `orca-lifecycle-matrix-${definition.agent}-`))
  const directory = root
  const host = await ensureStructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    stateDirectory: directory,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => directory,
    resolveLaunchArgs: () => [],
    resolveClaudeAuthPolicy: () => ({ account: 'system' }),
    resolveEnvironment: async () => ({ PATH: process.env.PATH }),
    ...child.deps,
    ...runtime
  })
  const fence = (): number => host.deps.store.getRecord(SESSION)?.lease.runtimeFence ?? 0
  const attachParams = hostTestAttachParams(null, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: operationId(),
      expectedRuntimeFence: null,
      payloadFingerprint: ''
    },
    provider: definition.agent,
    agent: definition.agent,
    accountHome: accountHome(definition, directory),
    providerHandle: undefined
  })
  const attached = await host.attach(CALLER, attachParams)
  expect(attached, JSON.stringify(attached)).toMatchObject({ ok: true })
  // A create whose reply was lost is retried under the same operation: no second agent starts.
  expect(await host.attach(CALLER, attachParams)).toMatchObject({ ok: true })
  expect(child.spawns()).toBe(1)
  const envelope = (method: string, fields: Record<string, unknown>) => ({
    sessionId: SESSION,
    clientOperationId: operationId(),
    expectedRuntimeFence: fence(),
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  })
  return {
    host,
    child,
    fence,
    send: async (text) => {
      const body = hostTestMessage(text)
      const sent = await host.send(CALLER, {
        envelope: envelope('agentSession.send', { body }),
        body
      })
      if (!sent.ok) {
        throw new Error(JSON.stringify(sent.refusal))
      }
      return sent.value.clientMessageId
    },
    stop: async () => {
      const stopped = await host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
      expect(stopped, JSON.stringify(stopped)).toMatchObject({ ok: true })
    },
    submission: async (clientMessageId) => {
      await host.flushStreamedEvents(SESSION)
      return (await host.journalSnapshot(SESSION)).submissions.find(
        (entry) => entry.clientMessageId === clientMessageId
      )
    },
    phase: () => host.readStatusSummary(SESSION)?.hostExecutionPhase
  }
}

describe.each(
  STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.map(
    ({ definition }) => [definition.agent, definition] as const
  )
)('%s, through its own adapter', (_agent, definition) => {
  it('publishes at spawn, takes a send while starting, and delivers it once started', async () => {
    const chat = await openChat(definition)
    expect(chat.phase()).toBe('starting')
    const sent = await chat.send('hello while starting')
    expect((await chat.submission(sent))?.dispatchState).toBe('pending')
    expect(chat.child.prompts()).toEqual([])

    chat.child.releaseHandshake()

    await eventually(() => expect(chat.child.prompts()).toEqual(['hello while starting']))
    expect(chat.phase()).toBe('ready')
    // The handle the provider answered with is what a later start resumes.
    expect(chat.host.deps.store.getRecord(SESSION)?.lease.provenHandleLinkId).not.toBeNull()
  })

  it('becomes ready without a first message', async () => {
    const chat = await openChat(definition)
    chat.child.releaseHandshake()
    await eventually(() => expect(chat.phase()).toBe('ready'))
    expect(chat.child.prompts()).toEqual([])
  })

  it('settles a message held through a failed start as never sent, and starts again on the next', async () => {
    const chat = await openChat(definition)
    const held = await chat.send('lost start')
    chat.child.failHandshake('the agent could not start')

    await eventually(async () =>
      expect((await chat.submission(held))?.dispatchState).toBe('rejected')
    )
    expect(chat.child.prompts()).toEqual([])

    chat.child.holdHandshakes = false
    await chat.send('after the failure')
    await eventually(() => expect(chat.child.prompts()).toEqual(['after the failure']))
    expect(chat.child.spawns()).toBe(2)
  })

  it('withdraws what it held when stopped while starting, and resumes nothing it never ran', async () => {
    const chat = await openChat(definition)
    const held = await chat.send('stopped before the start')
    await chat.stop()

    await eventually(async () =>
      expect((await chat.submission(held))?.dispatchState).toBe('rejected')
    )
    await eventually(() => expect(chat.child.closes()).toBe(1))
    expect(chat.child.prompts()).toEqual([])
  })

  it('ends the session on Stop, background work and all, and resumes the conversation on the next message', async () => {
    const chat = await openChat(definition)
    chat.child.holdHandshakes = false
    chat.child.releaseHandshake()
    chat.child.completeTurns = false
    await chat.send('long running work')
    await eventually(() => expect(chat.child.prompts()).toEqual(['long running work']))

    await chat.stop()

    await eventually(() => expect(chat.child.closes()).toBe(1))
    await eventually(() => expect(chat.phase()).toBeUndefined())
    chat.child.completeTurns = true
    await chat.send('after the Stop')
    await eventually(() =>
      expect(chat.child.prompts()).toEqual(['long running work', 'after the Stop'])
    )
    expect(chat.child.spawns()).toBe(2)
    expect(chat.child.resumes()).toBe(1)
  })

  it('stops a start that goes silent past its limit, failing what it held, and starts again on the next', async () => {
    const chat = await openChat(definition, { startupLimits: { silenceMs: 200 } })
    const held = await chat.send('held through a silent start')

    await eventually(async () =>
      expect((await chat.submission(held))?.dispatchState).toBe('rejected')
    )
    await eventually(() => expect(chat.child.closes()).toBe(1))
    expect(chat.child.prompts()).toEqual([])

    chat.child.holdHandshakes = false
    await chat.send('after the silent start')
    await eventually(() => expect(chat.child.prompts()).toEqual(['after the silent start']))
  })

  it("answers a worker's preamble pending once the caller's budget runs out, and delivers it when the agent starts", async () => {
    const chat = await openChat(definition)
    const preamble = await sendStructuredWorkerPreamble({
      ...workerPreamble(chat),
      budgetMs: 50
    })
    expect(preamble).toBe('pending')
    expect(chat.child.prompts()).toEqual([])

    chat.child.releaseHandshake()

    await eventually(() => expect(chat.child.prompts()).toEqual(['worker preamble']))
  })

  it("holds an orchestration worker's preamble until the agent has started", async () => {
    const chat = await openChat(definition)
    let settled = false
    const preamble = sendStructuredWorkerPreamble(workerPreamble(chat)).finally(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(settled).toBe(false)
    expect(chat.child.prompts()).toEqual([])

    chat.child.releaseHandshake()

    await expect(preamble).resolves.toMatch(/^(accepted|pending)$/)
    expect(chat.child.prompts()).toEqual(['worker preamble'])
  })
})

function workerPreamble(chat: Chat): Parameters<typeof sendStructuredWorkerPreamble>[0] {
  return {
    host: chat.host,
    sessionId: SESSION,
    dispatchId: 'ctx_matrix',
    preamble: 'worker preamble',
    from: {
      kind: 'agent',
      senders: [
        {
          party: { address: 'term_coord', terminalHandle: 'term_coord', orcaSessionId: null },
          name: 'Coordinator'
        }
      ],
      orchestration: { message: 'task', runId: 'r1', taskId: 't1', dispatchId: 'ctx_matrix' }
    }
  }
}
