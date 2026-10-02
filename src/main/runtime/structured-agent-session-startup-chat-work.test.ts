// The runtime's startup chat work, which the background copy of old chat files waits for: startup
// restoration until its first try settles, the first tab listing until it answers (or a bounded
// wait), tab listings, and the owed history restore until it has started. Each signal on its own
// holds the copy, and each clears.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { PerChatFileCopyStart } from '../native-chat/agent-session-wire/structured-agent-session-per-chat-file-copy-control'
import { OrcaRuntimeService } from './orca-runtime'
import {
  STARTUP_FIRST_LISTING_WAIT_MS,
  StructuredAgentSessionStartupChatWork
} from './structured-agent-session-startup-chat-work'
import {
  copyJob,
  createChats,
  createCopyTestRig,
  moveToPerChatFiles,
  perChatFilesLeft,
  type CopyTestRig
} from '../native-chat/agent-session-wire/structured-agent-session-per-chat-file-copy-test-rig'
import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/journal-host-database-test-support'

const rigs: CopyTestRig[] = []

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  for (const rig of rigs.splice(0)) {
    await rig.dispose()
  }
  closeTestJournalHostDatabases()
})

/** Chat work whose restoration has settled and whose first listing has answered, so each test sees
 *  only its own signal. */
async function preparedChatWork(): Promise<StructuredAgentSessionStartupChatWork> {
  const work = new StructuredAgentSessionStartupChatWork()
  await work.trackRestorationPrepare(async () => undefined)
  await work.trackListing(async () => undefined)
  return work
}

const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('the startup chat work the background copy waits for (R3M-2)', () => {
  it('holds until startup restoration’s first try settles, resolved or not', async () => {
    const resolved = new StructuredAgentSessionStartupChatWork()
    expect(resolved.isActive()).toBe(true)
    const prepare = Promise.withResolvers<void>()
    const done = resolved.trackRestorationPrepare(() => prepare.promise)
    expect(resolved.isActive()).toBe(true)
    prepare.resolve()
    await done
    await resolved.trackListing(async () => undefined)
    expect(resolved.isActive()).toBe(false)

    const rejected = new StructuredAgentSessionStartupChatWork()
    await rejected.trackListing(async () => undefined)
    await expect(
      rejected.trackRestorationPrepare(async () => {
        throw new Error('the terminal records refresh failed')
      })
    ).rejects.toThrow('refresh failed')
    expect(rejected.isActive()).toBe(false)
  })

  it('holds until the first tab listing has answered, past restoration, then clears (J3)', async () => {
    let now = 0
    const work = new StructuredAgentSessionStartupChatWork(() => now)
    await work.trackRestorationPrepare(async () => undefined)
    now += 30_000
    expect(work.isActive()).toBe(true)
    // A listing that fails answers nothing.
    await expect(
      work.trackListing(async () => {
        throw new Error('the host build failed')
      })
    ).rejects.toThrow('build failed')
    expect(work.isActive()).toBe(true)

    await work.trackListing(async () => undefined)
    expect(work.isActive()).toBe(false)
  })

  it('opens without a listing after its bounded wait, for a host no client lists (J3)', async () => {
    let now = 0
    const work = new StructuredAgentSessionStartupChatWork(() => now)
    await work.trackRestorationPrepare(async () => undefined)
    now = STARTUP_FIRST_LISTING_WAIT_MS - 1
    expect(work.isActive()).toBe(true)
    now = STARTUP_FIRST_LISTING_WAIT_MS
    expect(work.isActive()).toBe(false)
  })

  it('holds while a listing runs', async () => {
    const work = await preparedChatWork()
    const listing = Promise.withResolvers<void>()
    const done = work.trackListing(() => listing.promise)
    expect(work.isActive()).toBe(true)
    listing.resolve()
    await done
    expect(work.isActive()).toBe(false)
  })

  it('holds while a history restore is owed, and until it has started on the next macrotask', async () => {
    const work = await preparedChatWork()
    const start = vi.fn()
    work.oweRestore(start)
    expect(work.isActive()).toBe(true)

    work.startOwedRestoreSoon()
    expect(start).not.toHaveBeenCalled()
    expect(work.isActive()).toBe(true)
    await nextMacrotask()

    expect(start).toHaveBeenCalledOnce()
    expect(work.isActive()).toBe(false)
    // Started once: nothing is owed any more.
    work.startOwedRestoreSoon()
    await nextMacrotask()
    expect(start).toHaveBeenCalledOnce()
  })
})

describe('the copy waits for startup restoration on a desktop launch (R3M-1)', () => {
  it('waits for restoration, which the first listing waits for, however long it takes', async () => {
    const runtime = new OrcaRuntimeService()
    const refresh = Promise.withResolvers<Set<string>>()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test replaces only these protected startup members, which the runtime calls by name.
    const internal = runtime as unknown as {
      hasPersistedStructuredAgentSessionStore(): boolean
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
      ensureStructuredAgentSessionHost(): Promise<void>
      restoreStructuredAgentSessionTabsOnce(): Promise<void>
    }
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.refreshMobileSessionPtyRecords = () => refresh.promise
    internal.ensureStructuredAgentSessionHost = async () => undefined
    const copy: { start?: PerChatFileCopyStart } = {}
    const host = {
      reconcileRestartLeases: async () => undefined,
      seedStoredStatuses: (ids: readonly string[]) => [...ids],
      settleOwedSessions: async () => undefined,
      startPerChatFileCopy: (input: PerChatFileCopyStart) => {
        copy.start = input
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the startup step reaches only these host members.
    setStructuredAgentSessionHost(host as unknown as StructuredAgentSessionHost)

    // The step runs once the shell PATH is ready, long before the first window's services.
    await runtime.startStructuredAgentSessionStartup()
    expect(copy.start?.isRuntimeChatWorkActive()).toBe(true)

    // Restoration: after the first window's services, or their timeout.
    const prepared = runtime.prepareStructuredAgentSessionStartupRestoration()
    expect(copy.start?.isRuntimeChatWorkActive()).toBe(true)
    refresh.resolve(new Set())
    await prepared
    // Then the first listing, which the window sends once it can paint (J3).
    expect(copy.start?.isRuntimeChatWorkActive()).toBe(true)
    internal.restoreStructuredAgentSessionTabsOnce = async () => undefined
    await runtime.restoreStructuredAgentSessionTabs()
    expect(copy.start?.isRuntimeChatWorkActive()).toBe(false)
  })
})

describe('the copy waits for the first tab listing (J3)', () => {
  it('starts no chat before it answers, past its start delay and restoration, and starts right after', async () => {
    const rig = await createCopyTestRig()
    rigs.push(rig)
    await createChats(rig, ['session-old'], { listed: false })
    await rig.crash()
    moveToPerChatFiles(rig, ['session-old'])
    await rig.boot()
    const work = new StructuredAgentSessionStartupChatWork(() => rig.copyClock.now)
    await work.trackRestorationPrepare(async () => undefined)
    const job = copyJob(rig, {
      isStartupChatWorkActive: work.isActive,
      startDelayMs: undefined
    })

    for (let tick = 0; tick < 30; tick += 1) {
      rig.copyClock.now += 1_000
      await job.tick()
    }
    expect(await perChatFilesLeft(rig)).toBe(1)

    await work.trackListing(async () => undefined)
    rig.copyClock.now += 1_000
    await job.tick()
    expect(await perChatFilesLeft(rig)).toBe(0)
  })
})
