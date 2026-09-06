import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionHandoffRequest } from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { StructuredAgentSessionHandoffFlowRunner } from './structured-agent-session-handoff-flow-runner'
import { StructuredAgentSessionHandoffOperationGuard } from './structured-agent-session-handoff-operation-guard'
import type { StructuredAgentSessionHandoffFlowContext } from './structured-agent-session-handoff-types'

const NOW = 1_800_000_000_000
const SESSION = 'session-flow-runner-outcome-write-failure'
const THREAD = '019fd532-7c11-7a90-b6de-4e1a2c3d5f61'
const OPERATION = `${NOW}-00000000000000000000000000000002`
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fields = { direction: 'to-native' as const, mode: 'now' as const, action: 'retry' as const }

const params: AgentSessionHandoffRequest = {
  envelope: {
    sessionId: SESSION,
    clientOperationId: OPERATION,
    expectedRuntimeFence: null,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.requestHandoff',
      sessionId: SESSION,
      fields
    })
  },
  ...fields
}

/** A runner whose scheduled flow always rejects, so every case here exercises the failure path. */
async function failingFlowRunner(
  fail: (params: AgentSessionHandoffRequest, error: unknown) => void
): Promise<{
  runner: StructuredAgentSessionHandoffFlowRunner
  store: AgentSessionRecordStore
  root: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'orca-handoff-flow-runner-'))
  roots.push(root)
  const store = await AgentSessionRecordStore.open({
    directory: join(root, 'store'),
    hostId: 'local'
  })
  const journal = await openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: THREAD }
    },
    journalDir: join(root, 'journal')
  })
  const runner = new StructuredAgentSessionHandoffFlowRunner({
    deps: {
      store,
      claimKeyId: 'key-1',
      session: () => ({ journal, fence: 1 }),
      suspendNative: async () => ({ state: 'stopped' as const }),
      acquireNative: async () => {
        throw new Error('unused')
      },
      importTuiHistory: async () => {},
      publish: () => {},
      schedule: async () => {
        throw new Error('scheduling failed')
      },
      now: () => NOW
    },
    operationGuard: new StructuredAgentSessionHandoffOperationGuard(store),
    flowContext: (): StructuredAgentSessionHandoffFlowContext => {
      throw new Error('unreachable: scheduling rejects before the flow needs context')
    },
    fail
  })
  return { runner, store, root }
}

describe('structured handoff flow runner outcome-write failure', () => {
  it('still reports the flow failure when the failed-outcome ledger write throws', async () => {
    const failures: unknown[] = []
    const { runner, store, root } = await failingFlowRunner(
      (_params, error) => void failures.push(error)
    )
    // Materialize the store file so its later disappearance reads as corruption, making every
    // subsequent ledger write reject.
    await store.admitOperation({
      callerKey: 'seed',
      operationId: `${NOW}-00000000000000000000000000000009`,
      fingerprint: 'seed',
      now: NOW
    })
    await rm(join(root, 'store'), { recursive: true, force: true })

    runner.begin({ callerKey: 'client-1', params, turnId: null, fingerprint: 'fp' })
    await runner.drain()

    expect(failures).toHaveLength(1)
    expect((failures[0] as Error).message).toBe('scheduling failed')
  })

  it('does not leak an unhandled rejection when the failure notification itself throws', async () => {
    // The host's status publish threw exactly here once eviction had dropped the session.
    const { runner } = await failingFlowRunner(() => {
      throw new Error('agent_session_ownership_unknown')
    })
    const leaked: unknown[] = []
    const observe = (reason: unknown): void => void leaked.push(reason)
    process.on('unhandledRejection', observe)
    try {
      runner.begin({ callerKey: 'client-1', params, turnId: null, fingerprint: 'fp' })
      await runner.drain()
      // Node reports an orphaned rejection on the tick after it settles.
      await new Promise<void>((resolve) => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', observe)
    }

    expect(leaked).toEqual([])
  })
})
