import { join } from 'node:path'
import { Store } from '../../persistence/loading-store/store'
import { ProfileStateSqliteAuthority } from '../../persistence/profile-state/profile-state-sqlite-authority'
import { expect } from 'vitest'
import { OrchestrationDb } from '../../runtime/orchestration/db'
import { REST_TEST_CALLER, type RestTestRig } from './structured-agent-session-rest-test-rig'
import { hostTestOperationId } from './structured-agent-session-host-test-data'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { HOME_A, PARENT } from './structured-agent-session-receiving-callers.test-support'

/** The registered attach path reads launch defaults from the runtime's profile store. */
export function receivingRuntimeStore(root: string) {
  return new Store({
    dataFile: join(root, 'runtime-state.json'),
    profileStateAuthority: new ProfileStateSqliteAuthority(
      join(root, 'runtime-profile.db'),
      'receiving'
    )
  })
}

/** Build persisted success/pre-notice state with the real store and database owners. */
export function receivingPersistedFixtures({
  rig,
  params
}: {
  rig: RestTestRig
  params: () => AgentSessionAttachParams
}) {
  return {
    proveWithoutJournal: async () => {
      const input = params()
      await rig.store.reserveOwner({
        sessionId: PARENT,
        location: input.location,
        provider: 'claude',
        accountHome: HOME_A,
        expectedFence: null,
        spawnToken: 'pre-journal-spawn',
        claimKeyId: 'key-1',
        handoffOperationId: null,
        probe: { outcome: 'reservation-unused' },
        now: rig.clock.now,
        operation: {
          callerKey: REST_TEST_CALLER.callerKey,
          operationId: hostTestOperationId(),
          fingerprint: 'pre-journal-success'
        }
      })
      const record = rig.store.requireWritableRecord(PARENT)
      const acquired = await rig.adapter.acquire({
        identity: {
          sessionId: PARENT,
          workspaceId: input.location.workspaceId,
          hostId: 'local',
          agent: 'claude',
          providerHandle: null
        },
        fence: record.lease.runtimeFence,
        spawnToken: 'pre-journal-spawn'
      })
      await rig.store.commitProcessIdentity({
        sessionId: PARENT,
        fence: record.lease.runtimeFence,
        process: acquired.process,
        now: rig.clock.now
      })
      await rig.store.proveOwner({
        sessionId: PARENT,
        fence: record.lease.runtimeFence,
        ...(acquired.link ? { link: acquired.link } : {}),
        now: rig.clock.now,
        ...(acquired.accountRecipe
          ? {
              accountAcquisition: {
                generation: acquired.acquisitionGeneration,
                recipe: acquired.accountRecipe
              }
            }
          : {})
      })
      await rig.store.evictProvenDeadOwner({
        sessionId: PARENT,
        expectedFence: record.lease.runtimeFence,
        probe: { outcome: 'exit-observed' },
        now: rig.clock.now
      })
      expect(rig.store.requireWritableRecord(PARENT).lease).toMatchObject({
        claimStatus: 'released',
        ownerProcess: null,
        deathEvidence: { kind: 'exit-observed' }
      })
      await rig.store.setSessionTabVisibility(PARENT, true)
    },
    coldNative: async () => {
      await rig.host.close(PARENT, 'evict')
      expect(rig.host.hasSession(PARENT)).toBe(false)
      const db = new OrchestrationDb(join(rig.root, 'orchestration.db'))
      const run = db.createRun({
        objective: 'parent native work',
        coordinatorHandle: null,
        coordinatorPaneKey: null,
        coordinatorOrcaSessionId: PARENT
      })
      const started = db.createStartingWorkerDispatch({
        taskSpec: 'pre-notice',
        taskRunId: run.id,
        creator: { kind: 'session', orcaSessionId: PARENT },
        maxDepth: 9,
        startOptions: {}
      })
      db.close()
      return { run, started }
    }
  }
}
