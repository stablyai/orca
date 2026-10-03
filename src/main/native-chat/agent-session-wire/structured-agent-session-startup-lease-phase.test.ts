// Startup's one lease phase: the tab listing waits only on the recoveries of the chats opened before
// it, and no lease is checked again or recovered twice, whichever restore asks for it.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeTestJournalHostDatabases } from '../agent-session-journal/journal-host-database-test-support'
import { writeOlderBuildLease } from '../../runtime/agent-session-older-build-lease.test-fixture'
import {
  createRestTestRig,
  restTestChat,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import { latestRestTestStatus } from './structured-agent-session-rest-test-observations'
import { moveRestTestChatToPerChatFile } from './structured-agent-session-rest-test-per-chat-file'

const rigs: RestTestRig[] = []

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.dispose()
  }
  closeTestJournalHostDatabases()
  vi.restoreAllMocks()
})

const listedIds = (rig: RestTestRig) => rig.store.getVisibleSessionTabIndex().sessionIds

/**
 * A chat whose provider process was up when Orca died, left in a per-chat file when `inFile`. Its
 * process check answers once, which leaves its lease `recovering`, then never again; answers how
 * many checks hung.
 */
async function crashWithHungRecovery(
  rig: RestTestRig,
  sessionId: string,
  { listed, inFile }: { listed: boolean; inFile: boolean }
): Promise<() => number> {
  rig.adapter.dispatch.mockResolvedValueOnce({ state: 'admitted' })
  await restTestChat(rig, sessionId, { message: `asked ${sessionId}`, listed })
  // Held mid-send, before anything releases it.
  const lease = rig.store.getRecord(sessionId)!.lease
  await rig.host.flushAllStreamedEvents()
  await rig.crash()
  await writeOlderBuildLease(rig.root, sessionId, { ...lease })
  if (inFile) {
    await moveRestTestChatToPerChatFile(rig, sessionId)
  }
  let answered = false
  let hung = 0
  rig.probeOwner.mockImplementation(async (record) => {
    if (record.sessionId !== sessionId) {
      return { outcome: 'pid-absent' }
    }
    if (!answered) {
      answered = true
      return { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
    }
    hung += 1
    return new Promise(() => {})
  })
  return () => hung
}

/** Startup up to the listing's answer, as the host's step runs it; answers the restore's list. */
async function startupThroughListing(rig: RestTestRig): Promise<string[]> {
  const listed = listedIds(rig)
  await rig.host.reconcileRestartLeases()
  await rig.host.catchUpMissingStatuses(listed)
  await rig.host.restoreListedFromPerChatFiles(listed)
  return rig.host.seedStoredStatuses(listed)
}

const within = <T>(work: Promise<T>, ms: number) =>
  Promise.race([
    work.then(() => 'done'),
    new Promise((resolve) => setTimeout(() => resolve('still waiting'), ms))
  ])

describe('startup lease recovery, per lease', () => {
  it("answers the listing without waiting on a tabless chat's hung recovery", async () => {
    const rig = await createRestTestRig()
    rigs.push(rig)
    await restTestChat(rig, 'session-file', { message: 'asked session-file' })
    const hung = await crashWithHungRecovery(rig, 'session-tabless', {
      listed: false,
      inFile: false
    })
    await moveRestTestChatToPerChatFile(rig, 'session-file')
    vi.spyOn(rig.host.deps.logger, 'warn')
    await rig.boot({ startupRecoveryBudgetMs: 10_000 })
    expect(listedIds(rig)).toEqual(['session-file'])

    // The listed per-chat-file chat is opened before the listing; its own lease is settled.
    expect(await within(startupThroughListing(rig), 5_000)).toBe('done')
    expect(rig.host.hasSession('session-file')).toBe(true)
    expect(latestRestTestStatus(rig, 'session-file')).toMatchObject({ status: 'idle' })
    // The tabless chat's recovery is still running, started before the listing; the settle waits.
    expect(hung()).toBe(1)
    await rig.host.settleOwedSessions(listedIds(rig))
    expect(hung()).toBe(1)
  }, 30_000)

  it('does not check a listed per-chat-file chat again after the listing once its recovery outlasted startup', async () => {
    const rig = await createRestTestRig()
    rigs.push(rig)
    const hung = await crashWithHungRecovery(rig, 'session-file', { listed: true, inFile: true })
    vi.spyOn(rig.host.deps.logger, 'warn')
    await rig.boot({ startupRecoveryBudgetMs: 50 })

    expect(await within(startupThroughListing(rig), 5_000)).toBe('done')
    // Opened unverified before the listing: the hung check is left to the next attach or send.
    expect(rig.host.hasSession('session-file')).toBe(true)
    expect(rig.store.getRecord('session-file')!.lease.handoffStage).toBe('recovering')
    // The restore after the listing, given every listed chat, as when startup gave it no list.
    expect(await within(rig.host.restoreReadableSessions(listedIds(rig)), 3_000)).toBe('done')
    expect(hung()).toBe(1)
  }, 30_000)
})
