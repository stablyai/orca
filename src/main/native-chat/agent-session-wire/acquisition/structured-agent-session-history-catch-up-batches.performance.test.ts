import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { journalLifecycleItemMutation } from '../../agent-session-journal/writing/journal-lifecycle-mutation'
import { readTestJournalItems } from '../../agent-session-journal/journal-observation.test-support'
import { createTrackedJournalOpener } from '../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../journal-ingress/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../host/testing/structured-agent-session-logger.test-fixture'
import {
  continuedOutsideNotice,
  runHistoryCatchUp
} from './structured-agent-session-history-catch-up'
import { createHistoryCatchUpBatches } from './structured-agent-session-history-catch-up-batches'

const SESSION = 'session-catch-up-batches'
const journals = createTrackedJournalOpener({ legacyInputs: true })
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
})

async function importRows(count: number) {
  const root = await mkdtemp(join(tmpdir(), 'orca-catch-up-batches-'))
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('claude-session', null)
    } satisfies AgentSessionJournalIdentity,
    stateDirectory: root,
    now: () => 1_700_000_000
  })
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  deferred.bind({ journal, fence: 1, publish: () => {} })
  cleanups.push(async () => {
    deferred.close()
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })
  const delay = monitorEventLoopDelay({ resolution: 1 })
  const started = performance.now()
  delay.enable()
  const outcome = await runHistoryCatchUp({
    agentName: 'Claude',
    scope: 'catch-up-batches-performance',
    sessionId: SESSION,
    sink: deferred.sink,
    timeoutMs: 120_000,
    readView: async (history) => ({ physicalCursor: await history.reads.physicalCursor() }),
    prepare: async () => {
      const batches = createHistoryCatchUpBatches(() => {})
      for (let index = 0; index < count; index++) {
        batches.push(
          journalLifecycleItemMutation(
            { turnScope: AGENT_JOURNAL_THREAD_SCOPE },
            { provider: 'legacy', agent: 'claude', sessionId: SESSION, recordId: `row-${index}` },
            continuedOutsideNotice(false)
          )
        )
      }
      return batches.finish('batches-performance', count)
    }
  })
  delay.disable()
  const elapsedMs = performance.now() - started
  const blockMs = delay.max / 1e6
  expect(outcome).toBe('committed')
  expect((await readTestJournalItems(journal)).length).toBe(count)
  return { elapsedMs, blockMs }
}

// An import past one commit's bound lands whole, in commits that each stay inside it: total time
// grows with the rows, the longest main-thread block does not.
describe('history catch-up batches', () => {
  it(
    'imports 10x the rows in about 10x the time, with no longer main-thread block',
    async () => {
      const small = await importRows(1_000)
      const large = await importRows(10_000)
      console.info(
        `catch-up import: 1k rows ${small.elapsedMs.toFixed(0)}ms (max block ${small.blockMs.toFixed(1)}ms); ` +
          `10k rows ${large.elapsedMs.toFixed(0)}ms (max block ${large.blockMs.toFixed(1)}ms)`
      )
      expect(large.elapsedMs).toBeLessThan(small.elapsedMs * 20)
      expect(large.blockMs).toBeLessThan(Math.max(small.blockMs * 3, 250))
    },
    /* 11k real SQLite row writes run well past the default timeout on a slow CI runner. */ 180_000
  )
})
