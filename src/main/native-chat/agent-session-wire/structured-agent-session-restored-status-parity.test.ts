// Status rows now arrive after the tab list, from the post-listing restore pass. Each must end
// exactly where a fresh host lands when the same chat is opened directly by a read (T8, regression
// guard: the pass is main's own open path; this pins that moving it after the list changed nothing).

import { cp } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { closeTestJournalHostDatabases } from '../agent-session-journal/journal-host-database-test-support'
import {
  createRestTestRig,
  restTestChat,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import { latestRestTestStatus } from './structured-agent-session-rest-test-observations'

const rigs: RestTestRig[] = []

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.dispose()
  }
  closeTestJournalHostDatabases()
  vi.restoreAllMocks()
})

const CORPUS = ['session-settled', 'session-quiet', 'session-crashed', 'session-pending']

/** The chats a restart finds: two a clean quit settled, one cut off mid-turn by a crash, and one
 *  whose send the provider only admitted, left pending below a fence that has since moved. */
async function seedCorpus(rig: RestTestRig): Promise<void> {
  await restTestChat(rig, 'session-settled', { message: 'finished work' })
  await restTestChat(rig, 'session-quiet')
  await rig.host.flushAllStreamedEvents()
  await rig.boot()
  await restTestChat(rig, 'session-crashed', { message: 'cut off' })
  rig.adapter.dispatch.mockResolvedValueOnce({ state: 'admitted' })
  await restTestChat(rig, 'session-pending', { message: 'only admitted' })
  await rig.crash()
  // A live lease names the link proven at its fence, so the fence moves with that link.
  await rig.store.transitionHandoff('session-pending', (record) => ({
    ...record,
    lease: { ...record.lease, runtimeFence: record.lease.runtimeFence + 1 },
    providerHandleChain: record.providerHandleChain.map((link, index, chain) =>
      index === chain.length - 1 ? { ...link, mintedAtFence: link.mintedAtFence + 1 } : link
    )
  }))
}

it('ends every chat where a direct read of it lands, and shows no pre-crash work (T8)', async () => {
  const passRig = await createRestTestRig()
  rigs.push(passRig)
  await seedCorpus(passRig)
  // One copy of the files for each boot, taken while nothing is writing.
  closeTestJournalHostDatabases()
  const readRoot = `${passRig.root}-read`
  await cp(passRig.root, readRoot, { recursive: true })
  const readRig = await createRestTestRig({}, { root: readRoot })
  rigs.push(readRig)

  // Startup's shape: the lease check, the list, then the pass.
  const passHost = await passRig.boot()
  await passHost.reconcileRestartLeases()
  await passHost.restoreReadableSessions(CORPUS)

  // The same run, where the window reads each chat instead.
  const readHost = readRig.host
  await readHost.reconcileRestartLeases()
  for (const sessionId of CORPUS) {
    await readHost.history({ sessionId, direction: 'tail' })
  }

  // `updatedAt` is when the row was projected, a wall-clock read that differs between two boots.
  const rows = (rig: RestTestRig): Record<string, Omit<AgentSessionStatusSummary, 'updatedAt'>> =>
    Object.fromEntries(
      CORPUS.flatMap((sessionId) => {
        const summary = latestRestTestStatus(rig, sessionId)
        if (!summary) {
          return []
        }
        const { updatedAt: _updatedAt, ...row } = summary
        return [[sessionId, row]]
      })
    )
  await vi.waitFor(() => expect(rows(passRig)).toEqual(rows(readRig)))
  for (const sessionId of CORPUS) {
    expect(latestRestTestStatus(passRig, sessionId)).toBeDefined()
  }
  const crashedRows = passRig.statusEvents.flatMap((event) =>
    event.type === 'status' && event.session.sessionId === 'session-crashed' ? [event.session] : []
  )
  expect(crashedRows.map((row) => row.status)).not.toContain('working')
})
