import { readTestJournalSnapshot } from '../../../agent-session-journal/journal-observation.test-support'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AgentSessionDeathEvidence } from '../../../../../shared/agent-session/lifecycle/leases/agent-session-death-evidence'
import { readAgentJournalTurn } from '../../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { createTrackedJournalOpener } from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import '../structured-agent-session-dead-generation-settlement'
import { settleStaleStructuredAgentSessionState } from '../structured-agent-session-stale-state-settlement'
import { codexProviderHandle } from '../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import {
  RUNNING_IDENTITY,
  THREAD,
  turnScopeOf
} from './structured-agent-session-stale-verdict-contract.test-fixture'

it('ends a crashed turn at its last proof of life, not at a send accepted before the proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-stale-session-'))
  const journals = createTrackedJournalOpener({ legacyInputs: true })
  let now = 100
  try {
    const journal = await journals.open({
      identity: {
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle(THREAD)
      },
      stateDirectory: root,
      now: () => now
    })
    await journal.appendItem(
      RUNNING_IDENTITY,
      { kind: 'turn', turnId: 'turn-2', state: 'running', startedAt: 100 },
      { fence: 1, turnScope: turnScopeOf(RUNNING_IDENTITY) }
    )
    now = 200
    await journal.appendItem(
      { ...RUNNING_IDENTITY, ordinal: 1 },
      { kind: 'tool-call', name: 'shell', input: { command: 'pnpm test' }, state: 'running' },
      { fence: 1, turnScope: turnScopeOf(RUNNING_IDENTITY) }
    )
    const settle = (deathEvidence: AgentSessionDeathEvidence | null) =>
      settleStaleStructuredAgentSessionState({
        journal,
        sessionId: 'session-1',
        fence: 1,
        acquisitionGeneration: null,
        deathEvidence
      })
    now = 3_600_000
    await settle(null)
    const turn = async () =>
      (await readTestJournalSnapshot(journal)).items.map((item) =>
        readAgentJournalTurn(item.body)
      )[0]
    expect(await turn()).toMatchObject({ state: 'unverifiable' })
    now = 3_605_000
    await journal.appendSubmission({
      clientMessageId: 'send-1',
      payloadFingerprint: 'fingerprint-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'still there?' }] },
      fence: 1,
      handoverRecorded: true
    })
    await journal.resolveDispatch({
      clientMessageId: 'send-1',
      state: 'pending',
      turnScope: AGENT_JOURNAL_THREAD_SCOPE,
      fence: 1
    })
    now = 3_606_000

    await settle({
      kind: 'pid-absent',
      detail: 'gone',
      observedAt: 3_606_000,
      ownerFence: 1,
      lastProvenAliveAt: 210
    })

    expect(await turn()).toMatchObject({ state: 'interrupted', completedAt: 210 })
  } finally {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  }
})
