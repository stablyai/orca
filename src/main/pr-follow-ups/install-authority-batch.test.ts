import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FollowUpAction } from '../../shared/pr-follow-ups/contracts'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../runtime/agent-session/records/agent-session-record-store-test-harness'
import { closeTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { installation } from './install-scheduling.test-fixture'
import type { FollowUpActivityRouter } from './activity-journal'
import { recoverFollowUpLaunch } from './launch'

it.each([
  [10, 10],
  [100, 100],
  [100, 10]
])(
  'expands one owner once for a restart commit of %i unknown records and %i unresolved obligations',
  async (changedRecords, unresolved) => {
    const h = installation(unresolved + 1, false, 'chat', false, true)
    await h.flush()
    h.records.saveAction({
      ...h.records.action('active-pr0')!,
      sessionId: 'known-session',
      paneKey: undefined
    })
    for (let index = 1; index <= unresolved; index++) {
      h.records.saveAction({
        ...h.records.action(`active-pr${index}`)!,
        status: 'unconfirmed',
        sessionId: undefined,
        paneKey: undefined,
        sessionStartedAt: undefined
      })
    }
    await h.restart()
    const root = await mkdtemp(join(tmpdir(), 'orca-pr38950-authority-batch-'))
    try {
      await seedTestAgentSessionRecordStore(root, {
        records: Array.from({ length: changedRecords + 1 }, (_, index) => {
          // The known sibling comes first and must not mark this workspace expanded.
          const sessionId = index ? `ordinary-${index}` : 'known-session'
          const record = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
          return { ...record, location: { ...record.location, workspaceId: 'w0' } }
        })
      })
      const store = await openTestAgentSessionRecordStore(root)
      const router: FollowUpActivityRouter = Reflect.get(h.engine, 'activityRouter')
      const actions: Map<string, FollowUpAction> = Reflect.get(router, 'actions')
      const workspaces: Map<string, Set<string>> = Reflect.get(router, 'workspaces')
      const instances: Map<string, Set<string>> = Reflect.get(router, 'instances')
      const identities: Map<string, Set<string>> = Reflect.get(router, 'identities')
      const actionGet = vi.spyOn(actions, 'get')
      const workspaceGet = vi.spyOn(workspaces, 'get')
      const instanceGet = vi.spyOn(instances, 'get')
      const identityGet = vi.spyOn(identities, 'get')
      const route = h.engine.prKeysForAuthorities.bind(h.engine)
      const routes: {
        entries: number
        obligationVisits: number
        entryVisits: number
        workspaceReads: number
        instanceReads: number
        selected: string[]
      }[] = []
      vi.spyOn(h.engine, 'prKeysForAuthorities').mockImplementation((entries) => {
        const before = [actionGet, identityGet, workspaceGet, instanceGet].map(
          (spy) => spy.mock.calls.length
        )
        const selected = route(entries)
        routes.push({
          entries: entries.length,
          obligationVisits: actionGet.mock.calls.length - before[0]!,
          entryVisits: identityGet.mock.calls.length - before[1]!,
          workspaceReads: workspaceGet.mock.calls.length - before[2]!,
          instanceReads: instanceGet.mock.calls.length - before[3]!,
          selected
        })
        return selected
      })
      const recover = vi.mocked(recoverFollowUpLaunch).mockClear()
      // Positive disappearance changes every lease in one real record-store transaction.
      await store.reconcileOnRestart({ probe: async () => ({ outcome: 'pid-absent' }), now: h.now })
      await h.flush()
      expect(routes).toHaveLength(1)
      expect(routes[0]).toMatchObject({
        entries: changedRecords + 1,
        entryVisits: changedRecords + 1,
        obligationVisits: unresolved + 1,
        workspaceReads: 1,
        instanceReads: 0
      })
      expect(routes[0]!.selected).toEqual(
        Array.from({ length: unresolved + 1 }, (_, i) => `pr${i}`)
      )
      expect(recover).toHaveBeenCalledTimes(unresolved)

      // Expansion belongs to this call, and instance fallback follows the same rule.
      const workspaceBatch = vi.mocked(h.engine.prKeysForAuthorities).mock.calls[0]![0]
      const instanceBatch = [
        { recordId: 'known-session', instanceId: 'i0' },
        ...Array.from({ length: changedRecords }, (_, index) => ({
          recordId: `unknown-${index}`,
          instanceId: 'i0'
        }))
      ]
      for (let repeat = 0; repeat < 2; repeat++) {
        expect(h.engine.prKeysForAuthorities(workspaceBatch)).toEqual(routes[0]!.selected)
        expect(routes.at(-1)).toMatchObject({
          entryVisits: changedRecords + 1,
          obligationVisits: unresolved + 1,
          workspaceReads: 1,
          instanceReads: 0
        })
        expect(h.engine.prKeysForAuthorities(instanceBatch)).toEqual(routes[0]!.selected)
        expect(routes.at(-1)).toMatchObject({
          entryVisits: changedRecords + 1,
          obligationVisits: unresolved + 1,
          workspaceReads: 0,
          instanceReads: 1
        })
      }
    } finally {
      await closeTestJournalHostDatabase(root)
      await rm(root, { recursive: true, force: true })
    }
  }
)
