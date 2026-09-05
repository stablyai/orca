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

describe('structured handoff flow runner outcome-write failure', () => {
  it('still reports the flow failure when the failed-outcome ledger write throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-handoff-flow-runner-'))
    roots.push(root)
    const store = await AgentSessionRecordStore.open({
      directory: join(root, 'store'),
      hostId: 'local'
    })
    // Materialize the store file so its later disappearance reads as corruption,
    // making every subsequent ledger write reject.
    await store.admitOperation({
      callerKey: 'seed',
      operationId: `${NOW}-00000000000000000000000000000009`,
      fingerprint: 'seed',
      now: NOW
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
    await rm(join(root, 'store'), { recursive: true, force: true })
    const failures: unknown[] = []
    const fields = {
      direction: 'to-native' as const,
      mode: 'now' as const,
      action: 'retry' as const
    }
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
      fail: (_params, error) => {
        failures.push(error)
      }
    })
    runner.begin({ callerKey: 'client-1', params, turnId: null, fingerprint: 'fp' })
    await runner.drain()
    expect(failures).toHaveLength(1)
    expect((failures[0] as Error).message).toBe('scheduling failed')
  })
})
