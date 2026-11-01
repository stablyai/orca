import { closeTestJournalHostDatabases } from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import '../unused-default-rpc-methods.test-fixture'
/** An agent's own `orca agent launch` leaves one card in its chat; nothing else does, and the card never gates the launch. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import type { RpcContext } from '../core'
import { DESKTOP_RPC_CALLER, LOCAL_CLI_RPC_CALLER } from '../rpc-caller-identity'
import type { AgentCreationCard } from '../../orchestration/worker-start-card'
import {
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore,
  type AgentLaunchRuntimeStub
} from './agent-launch.test-fixture'

const CALLER_SESSION = 'codex_6cba3e14_b1a0_4b36_8f25_96c0dfa39fbb'
const cards: { sessionId: string; card: AgentCreationCard }[] = []

vi.mock('../../orchestration/worker-start-card', () => ({
  prepareAgentCreationCard: (sessionId: string | undefined) =>
    sessionId ? (card: () => AgentCreationCard) => cards.push({ sessionId, card: card() }) : null
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')

const NOW = Date.now()
const OPERATION_ID = `${NOW}-000000000000000000000000000000bb`
const SUBMIT = { text: 'fix the full-output stall', delivery: 'submit' }
const AGENT_CLI: Partial<RpcContext> = {
  caller: LOCAL_CLI_RPC_CALLER,
  orchestrationCompatibilityEvidence: { agentSessionId: CALLER_SESSION }
}

let directory: string

function promptingRuntime(): AgentLaunchRuntimeStub {
  return Object.assign(runtimeStub({ settings: {}, lineCarriesPrompt: true }), {
    waitForTerminal: vi.fn(async () => ({ satisfied: true, status: 'idle' })),
    waitForFreshWorkerComposer: vi.fn(async () => {
      throw new Error('timeout')
    }),
    sendTerminalAgentPrompt: vi.fn(async () => ({
      handle: 'term_1',
      accepted: true,
      bytesWritten: 1
    })),
    orchestrationSenderNames: {
      sender: (address: string) => ({
        party: { address, terminalHandle: address, orcaSessionId: null },
        name: 'Codex'
      })
    }
  })
}

async function launch(
  params: Record<string, unknown>,
  runtime: AgentLaunchRuntimeStub,
  context: Partial<RpcContext> = AGENT_CLI
) {
  const parsed = AGENT_LAUNCH.params.safeParse({
    agent: 'codex',
    target: { kind: 'existing', worktree: 'id:wt-7' },
    operationId: OPERATION_ID,
    ...params
  })
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'invalid')
  }
  return AGENT_LAUNCH.handler(parsed.data, rpcContext(runtime, context))
}

beforeEach(async () => {
  cards.length = 0
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-handoff-'))
  setAgentLaunchRecordStore(await openTestAgentSessionRecordStore(directory))
})

afterEach(async () => {
  setAgentLaunchRecordStore(null)
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

it('records one card in the launching chat, and a replay of the launch records none', async () => {
  const runtime = promptingRuntime()

  const first = await launch({ prompt: SUBMIT }, runtime)
  const replayed = await launch({ prompt: SUBMIT }, runtime)

  expect(replayed).toEqual(first)
  expect(cards).toEqual([
    {
      sessionId: CALLER_SESSION,
      card: {
        kind: 'agent-handoff',
        launchId: OPERATION_ID,
        agent: { party: expect.objectContaining({ address: 'term_1' }), name: 'Codex' },
        task: SUBMIT.text
      }
    }
  ])
})

it.each([
  [
    'a window',
    {
      caller: DESKTOP_RPC_CALLER,
      orchestrationCompatibilityEvidence: { agentSessionId: CALLER_SESSION }
    }
  ],
  [
    'a paired device',
    {
      caller: { kind: 'paired-device' as const, deviceId: 'device-1' },
      orchestrationCompatibilityEvidence: { agentSessionId: CALLER_SESSION }
    }
  ],
  ['a CLI outside a chat', { caller: LOCAL_CLI_RPC_CALLER }]
])('records nothing for a launch from %s', async (_label, context) => {
  await launch({ prompt: SUBMIT }, promptingRuntime(), context)

  expect(cards).toEqual([])
})

it('records nothing for a draft or a launch with no task', async () => {
  await launch({ prompt: { text: 'draft only', delivery: 'draft' } }, promptingRuntime())
  await launch({ operationId: `${NOW}-000000000000000000000000000000cc` }, promptingRuntime())

  expect(cards).toEqual([])
})

it('records nothing when the launch fails, and the failure is the launch’s own', async () => {
  const runtime = promptingRuntime()
  runtime.createTerminal.mockRejectedValueOnce(new Error('pty spawn failed'))

  await expect(launch({ prompt: SUBMIT }, runtime)).rejects.toThrow()
  expect(cards).toEqual([])
})
